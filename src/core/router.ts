// Core Cascading Router Engine for Edge AI Gateway
import type { ChatCompletionRequest, ModelCombo, Provider, TargetRoute, TelemetryLog } from "../types";
import type { StorageAdapter } from "../storage";
import { OAuthManager } from "./oauth";
import { KeyPoolManager } from "./pool";
import { createKeepAliveStream } from "./stream";
import { GeminiAdapter } from "../adapters/gemini";
import { AnthropicAdapter } from "../adapters/anthropic";
import { RequestSanitizer } from "./sanitizer";
import { RewriteEngine } from "./rewrite";
import { KeyManager, type ApiKeyRecord } from "./keys";
import { MetricsEngine } from "./metrics";
import { AdminAuth } from "./auth";

export class EdgeRouter {
  constructor(private storage: StorageAdapter, private onLog?: (log: TelemetryLog) => void) {}

  private logRecord(log: TelemetryLog): void {
    this.storage.recordLog(log);
    try {
      this.onLog?.(log);
    } catch {}
  }

  /**
   * Main dispatch entry for /v1/chat/completions
   */
  async dispatch(req: Request, body: ChatCompletionRequest): Promise<Response> {
    // 1. API Key Auth & Quota Enforcement
    let matchedApiKey: ApiKeyRecord | null = null;
    const authHeader = req.headers.get("Authorization");
    let clientKey = "";
    if (authHeader && authHeader.startsWith("Bearer ")) {
      clientKey = authHeader.slice(7).trim();
    }

    const allKeys = await this.storage.getKeys();
    let isAdmin = false;

    if (clientKey) {
      if (await AdminAuth.verify(req)) {
        isAdmin = true;
      } else {
        matchedApiKey = await this.storage.getKey(clientKey);
      }
    } else if (await AdminAuth.verify(req)) {
      isAdmin = true;
    }

    if (allKeys.length > 0 && !isAdmin) {
      if (!matchedApiKey) {
        return Response.json(
          {
            error: {
              message: "Invalid or missing API key. Please provide a valid Authorization: Bearer <key> header.",
              type: "authentication_error",
              code: "invalid_api_key",
            },
          },
          { status: 401 }
        );
      }

      const keyVal = KeyManager.validate(req, body, matchedApiKey);
      if (!keyVal.valid) {
        return Response.json(
          {
            error: {
              message: keyVal.error,
              type: "permission_error",
              code: keyVal.statusCode === 429 ? "quota_exceeded" : "unauthorized",
            },
          },
          { status: keyVal.statusCode || 403 }
        );
      }
    } else if (matchedApiKey) {
      const keyVal = KeyManager.validate(req, body, matchedApiKey);
      if (!keyVal.valid) {
        return Response.json(
          {
            error: {
              message: keyVal.error,
              type: "permission_error",
              code: keyVal.statusCode === 429 ? "quota_exceeded" : "unauthorized",
            },
          },
          { status: keyVal.statusCode || 403 }
        );
      }
    }

    // 2. Force Routing / Rewrite Rules (e.g. "claude-*-opus" -> "gemini-*-latest")
    const rules = await this.storage.getRules();
    const rewriteRes = RewriteEngine.rewrite(body.model, rules);
    const requestedModel = rewriteRes.targetModel;
    body.model = requestedModel;

    // Security check: if key has allowedModels, make sure rewritten model is ALSO permitted!
    if (matchedApiKey && matchedApiKey.allowedModels && matchedApiKey.allowedModels.length > 0) {
      const isAllowedPostRewrite = matchedApiKey.allowedModels.some((pattern) => {
        try {
          const regex = RewriteEngine.compilePattern(pattern.trim());
          return regex.test(requestedModel);
        } catch {
          return pattern.trim() === requestedModel;
        }
      });
      if (!isAllowedPostRewrite) {
        return Response.json(
          {
            error: {
              message: `Target model '${requestedModel}' after rewrite is not authorized for this API key`,
              type: "permission_error",
              code: "unauthorized",
            },
          },
          { status: 403 }
        );
      }
    }

    const isStream = Boolean(body.stream);
    const startMs = Date.now();

    // 3. Resolve targets: either from a Combo alias or direct provider route
    const targets = await this.resolveTargets(requestedModel);

    if (targets.length === 0) {
      return Response.json(
        {
          error: {
            message: `Model '${requestedModel}' not found in active combos or providers`,
            type: "invalid_request_error",
            code: "model_not_found",
          },
        },
        { status: 404 }
      );
    }

    // 2. Cascading Failover Loop
    let lastError: { status: number; message: string } = { status: 502, message: "All targets failed" };

    for (const target of targets) {
      const provider = await this.storage.getProvider(target.providerId);
      if (!provider || !provider.enabled) continue;

      // Select active healthy key from pool or OAuth JIT
      const oauthToken = await OAuthManager.getValidAccessToken(provider);
      const token = oauthToken || KeyPoolManager.selectKey(provider);

      try {
        let upstreamUrl = "";
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          ...(provider.headers || {}),
        };
        let upstreamBody: unknown;

        // -----------------------------------------------------------------
        // Protocol Adapters
        // -----------------------------------------------------------------
        if (provider.type === "gemini") {
          const action = isStream ? "streamGenerateContent?alt=sse" : "generateContent";
          upstreamUrl = `${provider.baseUrl.replace(/\/+$/, "")}/v1beta/models/${target.model}:${action}`;
          if (token) {
            headers["x-goog-api-key"] = token;
          }
          upstreamBody = GeminiAdapter.transformRequest(body);
        } else if (provider.type === "anthropic") {
          upstreamUrl = `${provider.baseUrl.replace(/\/+$/, "")}/v1/messages`;
          if (token) {
            headers["x-api-key"] = token;
          }
          headers["anthropic-version"] = "2023-06-01";
          upstreamBody = AnthropicAdapter.transformRequest(body, target.model);
        } else {
          // Standard OpenAI Compatible
          upstreamUrl = new URL("/v1/chat/completions", provider.baseUrl).toString();
          if (token) {
            headers["Authorization"] = `Bearer ${token}`;
          }
          const sanitizedPayload = RequestSanitizer.sanitize(body, provider);
          upstreamBody = {
            ...sanitizedPayload,
            model: target.model,
          };
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), target.timeoutMs || 180000);

        const upstreamRes = await fetch(upstreamUrl, {
          method: "POST",
          headers,
          body: JSON.stringify(upstreamBody),
          signal: controller.signal,
        });

        clearTimeout(timeout);
        const latencyMs = Date.now() - startMs;

        // Circuit Breaker & Failover check
        if ([401, 403, 429, 500, 502, 503, 504].includes(upstreamRes.status)) {
          if (token && [401, 403, 429].includes(upstreamRes.status)) {
            KeyPoolManager.markCooldown(token, 180000); // 3 minutes cooldown on bad/rate-limited keys
          }
          const errText = await upstreamRes.text();
          console.warn(`[Failover] Target ${target.providerId}/${target.model} returned ${upstreamRes.status}. Cascading...`);
          lastError = { status: upstreamRes.status, message: errText };
          continue; // Try next cascade target!
        }

        // Success!
        if (upstreamRes.ok) {
          if (token) {
            KeyPoolManager.markSuccess(token);
          }

          const onUsageCallback = (usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }) => {
            const tot = usage.total_tokens ?? ((usage.prompt_tokens || 0) + (usage.completion_tokens || 0));
            this.logRecord({
              id: crypto.randomUUID(),
              timestamp: Date.now(),
              model: requestedModel,
              targetProvider: provider.id,
              targetModel: target.model,
              status: 200,
              latencyMs,
              tokens: tot,
              promptTokens: usage.prompt_tokens ?? 0,
              completionTokens: usage.completion_tokens ?? 0,
            });

            if (matchedApiKey) {
              this.storage.deductKeyUsage(matchedApiKey.id, {
                requests: 1,
                tokens: tot,
                promptTokens: usage.prompt_tokens ?? 0,
                completionTokens: usage.completion_tokens ?? 0,
              });
            }
          };

          // ---------------------------------------------------------------
          // Response Normalization: Streaming
          // ---------------------------------------------------------------
          if (isStream && upstreamRes.body) {
            let transformedStream: ReadableStream<Uint8Array>;

            if (provider.type === "gemini") {
              transformedStream = GeminiAdapter.createStreamTransformer(upstreamRes.body, requestedModel, onUsageCallback);
            } else if (provider.type === "anthropic") {
              transformedStream = AnthropicAdapter.createStreamTransformer(upstreamRes.body, requestedModel, onUsageCallback);
            } else {
              transformedStream = createKeepAliveStream(upstreamRes.body, {
                pingIntervalMs: 15000,
                streamStartTime: startMs,
                onTtft: (ttftMs) => {
                  MetricsEngine.record(target.providerId, target.model, ttftMs, ttftMs);
                },
                onUsage: onUsageCallback,
              });
            }

            const streamHeaders = new Headers(upstreamRes.headers);
            streamHeaders.set("Content-Type", "text/event-stream");
            streamHeaders.set("Cache-Control", "no-cache");
            streamHeaders.set("Connection", "keep-alive");
            streamHeaders.set("Access-Control-Allow-Origin", "*");

            return new Response(transformedStream, {
              status: 200,
              headers: streamHeaders,
            });
          }

          // ---------------------------------------------------------------
          // Response Normalization: Non-Streaming
          // ---------------------------------------------------------------
          let rawText = await upstreamRes.text();
          const doneIdx = rawText.indexOf("data: [DONE]");
          if (doneIdx !== -1) {
            rawText = rawText.slice(0, doneIdx).trim();
          }

          let responseJson: Record<string, unknown>;

          if (provider.type === "gemini") {
            const rawJson = JSON.parse(rawText);
            responseJson = GeminiAdapter.transformResponse(rawJson, requestedModel);
          } else if (provider.type === "anthropic") {
            const rawJson = JSON.parse(rawText);
            responseJson = AnthropicAdapter.transformResponse(rawJson, requestedModel);
          } else {
            try {
              responseJson = JSON.parse(rawText) as Record<string, unknown>;
            } catch {
              let sseTokens = 0;
              let ssePrompt = 0;
              let sseComp = 0;
              const matchTot = rawText.match(/"total_tokens":\s*(\d+)/);
              const matchPrompt = rawText.match(/"prompt_tokens":\s*(\d+)/);
              const matchComp = rawText.match(/"completion_tokens":\s*(\d+)/);
              if (matchTot) sseTokens = parseInt(matchTot[1], 10);
              if (matchPrompt) ssePrompt = parseInt(matchPrompt[1], 10);
              if (matchComp) sseComp = parseInt(matchComp[1], 10);

              this.logRecord({
                id: crypto.randomUUID(),
                timestamp: Date.now(),
                model: requestedModel,
                targetProvider: provider.id,
                targetModel: target.model,
                status: upstreamRes.status,
                latencyMs,
                tokens: sseTokens,
                promptTokens: ssePrompt,
                completionTokens: sseComp,
              });

              if (matchedApiKey) {
                this.storage.deductKeyUsage(matchedApiKey.id, {
                  requests: 1,
                  tokens: sseTokens,
                  promptTokens: ssePrompt,
                  completionTokens: sseComp,
                });
              }

              return new Response(rawText, {
                status: upstreamRes.status,
                headers: {
                  "Access-Control-Allow-Origin": "*",
                  "Content-Type": "application/json",
                },
              });
            }
          }

          const usage = responseJson?.usage as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;
          const tot = usage?.total_tokens ?? ((usage?.prompt_tokens || 0) + (usage?.completion_tokens || 0));

          // Record telemetry asynchronously
          this.logRecord({
            id: crypto.randomUUID(),
            timestamp: Date.now(),
            model: requestedModel,
            targetProvider: provider.id,
            targetModel: target.model,
            status: 200,
            latencyMs,
            tokens: tot,
            promptTokens: usage?.prompt_tokens ?? 0,
            completionTokens: usage?.completion_tokens ?? 0,
          });

          MetricsEngine.record(target.providerId, target.model, latencyMs, latencyMs);

          if (matchedApiKey) {
            this.storage.deductKeyUsage(matchedApiKey.id, {
              requests: 1,
              tokens: tot,
              promptTokens: usage?.prompt_tokens ?? 0,
              completionTokens: usage?.completion_tokens ?? 0,
            });
          }

          return Response.json(responseJson, {
            status: 200,
            headers: {
              "Access-Control-Allow-Origin": "*",
              "Content-Type": "application/json",
            },
          });
        }

        // Other client errors (e.g. 400 Bad Request) are returned directly without failover
        const errorText = await upstreamRes.text();
        return new Response(errorText, {
          status: upstreamRes.status,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[Failover] Network error on ${provider.id}/${target.model}: ${msg}`);
        lastError = { status: 504, message: msg };
      }
    }

    return Response.json(
      {
        error: {
          message: `All upstream targets exhausted. Last error: ${lastError.message}`,
          type: "upstream_error",
          code: lastError.status,
        },
      },
      { status: lastError.status }
    );
  }

  private async resolveTargets(modelName: string): Promise<TargetRoute[]> {
    // 1. Check if model matches an active combo
    const combo = await this.storage.getCombo(modelName);
    if (combo && combo.enabled !== false && combo.targets.length > 0) {
      return MetricsEngine.sortTargets(combo.targets, combo.strategy || "fallback", combo.id);
    }

    // 2. Check if model matches a direct provider format: "providerId/modelName"
    if (modelName.includes("/")) {
      const slashIdx = modelName.indexOf("/");
      const providerId = modelName.slice(0, slashIdx);
      const rawModel = modelName.slice(slashIdx + 1);
      const provider = await this.storage.getProvider(providerId);
      if (provider) {
        return [{ providerId, model: rawModel }];
      }
    }

    return [];
  }
}
