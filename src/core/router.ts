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
  private ctx?: { waitUntil(promise: Promise<unknown>): void };

  constructor(private storage: StorageAdapter, private onLog?: (log: TelemetryLog) => void) {}

  private logRecord(log: TelemetryLog): void {
    const task = async () => {
      try {
        await this.storage.recordLog(log);
        this.onLog?.(log);
      } catch (err) {
        console.error("[Telemetry] Failed to record log:", err);
      }
    };

    if (this.ctx?.waitUntil) {
      this.ctx.waitUntil(task());
    } else {
      task();
    }
  }

  /**
   * Main dispatch entry for /v1/chat/completions
   */
  async dispatch(
    req: Request,
    body: ChatCompletionRequest,
    ctx?: { waitUntil(promise: Promise<unknown>): void }
  ): Promise<Response> {
    this.ctx = ctx;
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

    // 2. Force Routing / Rewrite Rules (e.g. "claude-*-opus" -> "gemini-*-latest")
    const rules = await this.storage.getRules();
    const rewriteRes = RewriteEngine.rewrite(body.model, rules);
    const requestedModel = rewriteRes.targetModel;
    const originalModel = body.model;
    body.model = requestedModel;

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

      const providerKeys = KeyPoolManager.extractKeys(provider);
      const maxKeyAttempts = providerKeys.length > 0 ? Math.min(providerKeys.length, 3) : 1;

      for (let keyAttempt = 0; keyAttempt < maxKeyAttempts; keyAttempt++) {
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
        const timeout = setTimeout(() => controller.abort(), target.timeoutMs || 25000);

        let upstreamRes = await fetch(upstreamUrl, {
          method: "POST",
          headers,
          body: JSON.stringify(upstreamBody),
          signal: controller.signal,
        });

        clearTimeout(timeout);
        const latencyMs = Date.now() - startMs;

        // Circuit Breaker & Failover check
        let errText = !upstreamRes.ok ? await upstreamRes.text() : "";
        let isGeoBlocked = upstreamRes.status === 400 && (
          errText.includes("User location") ||
          errText.includes("FAILED_PRECONDITION") ||
          errText.includes("location is not supported")
        );

        // Auto-recover from Geo-Blocking via Cloudflare AI Gateway
        if (isGeoBlocked && provider.type === "gemini" && !upstreamUrl.includes("gateway.ai.cloudflare.com")) {
          const gatewayBase = "https://gateway.ai.cloudflare.com/v1/55652c981f1479f487a7978990d6c430/nixai/google-ai-studio";
          const gatewayUrl = upstreamUrl.replace(/https:\/\/generativelanguage\.googleapis\.com/, gatewayBase);
          console.warn(`[GeoBlock Bypass] Retrying ${target.providerId}/${target.model} via Cloudflare AI Gateway...`);
          try {
            const gwRes = await fetch(gatewayUrl, {
              method: "POST",
              headers,
              body: JSON.stringify(upstreamBody),
              signal: AbortSignal.timeout(target.timeoutMs || 25000),
            });
            upstreamRes = gwRes;
            if (!upstreamRes.ok) {
              errText = await upstreamRes.text();
            } else {
              errText = "";
            }
            isGeoBlocked = false;
          } catch (gwErr) {
            console.warn(`[GeoBlock Bypass] Gateway fallback failed: ${gwErr}`);
          }
        }

        const isFailoverStatus = [401, 403, 404, 408, 429, 500, 502, 503, 504].includes(upstreamRes.status) || isGeoBlocked;

        if (isFailoverStatus) {
          if (token && [401, 403, 429, 503].includes(upstreamRes.status)) {
            KeyPoolManager.markCooldown(token, 180000); // 3 minutes cooldown on bad/rate-limited/congested keys
          }
          console.warn(`[Failover] Target ${target.providerId}/${target.model} returned ${upstreamRes.status} (key attempt ${keyAttempt + 1}/${maxKeyAttempts}).`);
          lastError = { status: upstreamRes.status, message: errText };
          if (token && [401, 403, 429, 503].includes(upstreamRes.status) && keyAttempt + 1 < maxKeyAttempts) {
            continue; // Try next key in same provider!
          }
          break; // Try next cascade target!
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
              const deductTask = async () => {
                try {
                  await this.storage.deductKeyUsage(matchedApiKey.id, {
                    requests: 1,
                    tokens: tot,
                    promptTokens: usage.prompt_tokens ?? 0,
                    completionTokens: usage.completion_tokens ?? 0,
                  });
                } catch (err) {
                  console.error("[Billing] Failed to deduct key usage:", err);
                }
              };
              if (this.ctx?.waitUntil) {
                this.ctx.waitUntil(deductTask());
              } else {
                deductTask();
              }
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
            const deductTask = async () => {
              try {
                await this.storage.deductKeyUsage(matchedApiKey.id, {
                  requests: 1,
                  tokens: tot,
                  promptTokens: usage?.prompt_tokens ?? 0,
                  completionTokens: usage?.completion_tokens ?? 0,
                });
              } catch (err) {
                console.error("[Billing] Failed to deduct key usage:", err);
              }
            };
            if (this.ctx?.waitUntil) {
              this.ctx.waitUntil(deductTask());
            } else {
              deductTask();
            }
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
        return new Response(errText, {
          status: upstreamRes.status,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[Failover] Network error on ${provider.id}/${target.model}: ${msg}`);
        lastError = { status: 504, message: msg };
        if (keyAttempt + 1 < maxKeyAttempts) continue;
        break;
      }
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

    // 3. Fallback: Fuzzy Smart Aliasing (ONLY runs when model would otherwise return 404!)
    const allCombos = await this.storage.getCombos();
    const activeCombos = allCombos.filter((c) => c.enabled !== false && c.targets && c.targets.length > 0);
    const lower = modelName.toLowerCase();

    // Prioritize non-free combos (*-latest / smart-tier) over legacy free-* combos
    const nonFreeCombos = activeCombos.filter((c) => !c.id.startsWith("free-"));
    const pool = nonFreeCombos.length > 0 ? nonFreeCombos : activeCombos;

    let fallbackCombo: (typeof activeCombos)[0] | undefined;
    if (lower.startsWith("claude") || lower.startsWith("sonnet") || lower.startsWith("opus")) {
      fallbackCombo = pool.find((c) => c.id === "smart-tier" || c.id === "claude-sonnet-latest" || c.id === "claude-opus-latest" || c.id.includes("claude"));
    } else if (lower.startsWith("gemini")) {
      fallbackCombo = pool.find((c) => c.id === "gemini-flash-latest" || c.id === "gemini-pro-latest" || c.id.includes("gemini"));
    } else if (lower.startsWith("gpt") || lower.startsWith("o1") || lower.startsWith("o3") || lower.startsWith("o4")) {
      fallbackCombo = pool.find((c) => c.id === "gpt-latest" || c.id === "smart-tier" || c.id.includes("gpt"));
    } else if (lower.startsWith("deepseek")) {
      fallbackCombo = pool.find((c) => c.id === "deepseek-pro-latest" || c.id === "deepseek-flash-latest" || c.id.includes("deepseek"));
    }

    if (fallbackCombo) {
      console.warn(`[Fuzzy Route] Model '${modelName}' not found; resolving to fallback combo '${fallbackCombo.id}'`);
      return MetricsEngine.sortTargets(fallbackCombo.targets, fallbackCombo.strategy || "fallback", fallbackCombo.id);
    }

    return [];
  }
}
