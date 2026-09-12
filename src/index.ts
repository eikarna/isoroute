// Entrypoint: Isomorphic Serverless & Bun Native Runtime
import { EdgeRouter } from "./core/router";
import { SqliteStorageAdapter } from "./storage/sqlite";
import { ModelDiscovery } from "./core/discovery";
import { OAuthManager } from "./core/oauth";
import { AdminAuth } from "./core/auth";
import { ProviderProbe } from "./core/probe";
import { KeyManager, type ApiKeyRecord } from "./core/keys";
import { BulkIngestEngine } from "./core/bulk";
import type { RouteRule } from "./core/rewrite";
import type { ChatCompletionRequest, ModelCombo, Provider } from "./types";
import DASHBOARD_HTML from "../dist/index.html" with { type: "text" };
import { PUBLIC_LANDING_HTML } from "./landingHtml";

// Seed initial default test providers & combos
const initialProviders: Provider[] = [
  {
    id: "local-9router",
    name: "9Router Local",
    baseUrl: "http://127.0.0.1:20128",
    apiKey: process.env.HERMES_CUSTOM_127_0_0_1_20128_API_KEY || "",
    type: "openai",
    enabled: true,
  },
  {
    id: "tokenrouter-mock",
    name: "TokenRouter Fallback",
    baseUrl: "https://api.tokenrouter.io",
    apiKey: "sk-fallback",
    type: "openai",
    enabled: false,
  },
];

const initialCombos: ModelCombo[] = [
  {
    id: "free-fast",
    displayName: "Free Fast Gemini",
    description: "Ultra fast model with failover",
    enabled: true,
    targets: [
      { providerId: "local-9router", model: "free-gemini-flash", priority: 10 },
      { providerId: "local-9router", model: "gemini-flash-latest", priority: 5 },
    ],
  },
  {
    id: "free-qwen",
    displayName: "Free Qwen Flagship",
    description: "Multi-tier fallback for Qwen models",
    enabled: true,
    targets: [
      { providerId: "local-9router", model: "tokenrouter/qwen/qwen3.8-max", priority: 10 },
      { providerId: "local-9router", model: "opf/Qwen3.7 Plus", priority: 5 },
    ],
  },
  {
    id: "smart-tier",
    displayName: "Smart Tier Router",
    description: "Automatic failover for general coding & reasoning",
    enabled: true,
    targets: [
      { providerId: "local-9router", model: "free-uncensored", priority: 10 },
    ],
  },
];

const storage = new SqliteStorageAdapter("edge-router.db");

// Seed initial default test providers & combos if empty
const existingProviders = await storage.getProviders();
if (existingProviders.length === 0) {
  for (const p of initialProviders) await storage.saveProvider(p);
}
const existingCombos = await storage.getCombos();
if (existingCombos.length === 0) {
  for (const c of initialCombos) await storage.saveCombo(c);
}

// Live SSE Event Bus for sub-millisecond telemetry broadcast
type LiveSubscriber = (eventData: string) => void;
const liveSubscribers = new Set<LiveSubscriber>();

export function broadcastLiveEvent(event: Record<string, unknown>) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const sub of liveSubscribers) {
    try {
      sub(payload);
    } catch {
      liveSubscribers.delete(sub);
    }
  }
}

const router = new EdgeRouter(storage, (log) => {
  broadcastLiveEvent({ type: "log", log });
});

export async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  // CORS Preflight
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }

  // 1. OpenAI Compatible Endpoints
  if (path === "/v1/models" && request.method === "GET") {
    const combos = await storage.getCombos();
    const models = combos.map((c) => ({
      id: c.id,
      object: "model",
      created: 1700000000,
      owned_by: "edge-router",
      display_name: c.displayName,
    }));

    return Response.json(
      { object: "list", data: models },
      { headers: { "Access-Control-Allow-Origin": "*" } }
    );
  }

  if (path === "/v1/chat/completions" && request.method === "POST") {
    try {
      const body = (await request.json()) as ChatCompletionRequest;
      return await router.dispatch(request, body);
    } catch (err) {
      return Response.json(
        { error: { message: err instanceof Error ? err.message : "Invalid JSON", type: "invalid_request_error" } },
        { status: 400, headers: { "Access-Control-Allow-Origin": "*" } }
      );
    }
  }

  // 2. Authentication Endpoint (Default: 123456)
  if (path === "/api/auth/login" && request.method === "POST") {
    try {
      const { password } = (await request.json()) as { password?: string };
      const authRes = await AdminAuth.login(password || "");
      if (authRes.success) {
        return Response.json(
          { success: true, token: authRes.token },
          {
            headers: {
              "Access-Control-Allow-Origin": "*",
              "Set-Cookie": `edge_admin_token=${authRes.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`,
            },
          }
        );
      }
      return Response.json({ error: authRes.error }, { status: 401, headers: { "Access-Control-Allow-Origin": "*" } });
    } catch {
      return Response.json({ error: "Invalid login payload" }, { status: 400, headers: { "Access-Control-Allow-Origin": "*" } });
    }
  }

  // 3. Management & Telemetry REST APIs & SSE Realtime Stream
  if (path === "/api/live" && request.method === "GET") {
    if (!(await AdminAuth.verify(request))) {
      return Response.json({ error: "Unauthorized: Admin login required" }, { status: 401, headers: { "Access-Control-Allow-Origin": "*" } });
    }

    const encoder = new TextEncoder();
    let sub: LiveSubscriber | null = null;
    let pingInterval: any = null;

    const stream = new ReadableStream({
      start(controller) {
        sub = (data: string) => {
          try {
            controller.enqueue(encoder.encode(data));
          } catch {
            if (sub) liveSubscribers.delete(sub);
          }
        };
        liveSubscribers.add(sub);
        controller.enqueue(encoder.encode(": connected\n\n"));

        pingInterval = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": ping\n\n"));
          } catch {
            if (pingInterval) clearInterval(pingInterval);
            if (sub) liveSubscribers.delete(sub);
          }
        }, 15000);
      },
      cancel() {
        if (sub) liveSubscribers.delete(sub);
        if (pingInterval) clearInterval(pingInterval);
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  if (path === "/api/status" && request.method === "GET") {
    const url = new URL(request.url);
    const timeframe = url.searchParams.get("timeframe");
    let since: number | undefined;
    let until: number | undefined;

    if (timeframe === "24h" || timeframe === "1d") since = Date.now() - 24 * 3600 * 1000;
    else if (timeframe === "7d") since = Date.now() - 7 * 86400 * 1000;
    else if (timeframe === "30d") since = Date.now() - 30 * 86400 * 1000;
    else if (timeframe === "1y") since = Date.now() - 365 * 86400 * 1000;

    if (url.searchParams.has("since")) since = parseInt(url.searchParams.get("since")!, 10);
    if (url.searchParams.has("until")) until = parseInt(url.searchParams.get("until")!, 10);

    const sortBy = (url.searchParams.get("sortBy") as any) || "timestamp";
    const order = (url.searchParams.get("order") as any) || "desc";
    const limit = url.searchParams.has("limit") ? parseInt(url.searchParams.get("limit")!, 10) : 20;

    const metrics = await storage.getMetrics({ since, until });
    const logs = await storage.getLogs({ limit, since, until, sortBy, order });
    return Response.json({ status: "healthy", metrics, logs, timeframe: timeframe || "all" }, { headers: { "Access-Control-Allow-Origin": "*" } });
  }

  if (path === "/api/logs" && request.method === "GET") {
    const url = new URL(request.url);
    const timeframe = url.searchParams.get("timeframe");
    let since: number | undefined;
    let until: number | undefined;

    if (timeframe === "24h" || timeframe === "1d") since = Date.now() - 24 * 3600 * 1000;
    else if (timeframe === "7d") since = Date.now() - 7 * 86400 * 1000;
    else if (timeframe === "30d") since = Date.now() - 30 * 86400 * 1000;
    else if (timeframe === "1y") since = Date.now() - 365 * 86400 * 1000;

    if (url.searchParams.has("since")) since = parseInt(url.searchParams.get("since")!, 10);
    if (url.searchParams.has("until")) until = parseInt(url.searchParams.get("until")!, 10);

    const sortBy = (url.searchParams.get("sortBy") as any) || "timestamp";
    const order = (url.searchParams.get("order") as any) || "desc";
    const limit = url.searchParams.has("limit") ? parseInt(url.searchParams.get("limit")!, 10) : 100;

    const logs = await storage.getLogs({ limit, since, until, sortBy, order });
    return Response.json({ logs }, { headers: { "Access-Control-Allow-Origin": "*" } });
  }

  if (path === "/api/combos" && request.method === "GET") {
    const combos = await storage.getCombos();
    return Response.json({ combos }, { headers: { "Access-Control-Allow-Origin": "*" } });
  }

  // Headless Model & Combo Discovery API (9Router parity)
  if (path === "/api/models" && request.method === "GET") {
    const combos = await storage.getCombos();
    const providers = await storage.getProviders();
    return Response.json({
      models: combos.map((c) => ({
        id: c.id,
        name: c.displayName,
        description: c.description,
        targets: c.targets,
        enabled: c.enabled,
      })),
      totalCombos: combos.length,
      totalProviders: providers.length,
    }, { headers: { "Access-Control-Allow-Origin": "*" } });
  }

  // Bulk Ingest Providers (API keys, OAuth, Cookie sessions, or Key Pooling)
  if (path === "/api/providers/bulk" && request.method === "POST") {
    if (!(await AdminAuth.verify(request))) {
      return Response.json({ error: "Unauthorized: Admin auth required" }, { status: 401, headers: { "Access-Control-Allow-Origin": "*" } });
    }
    const start = Date.now();
    const contentType = request.headers.get("content-type") || "";
    let rawData: any;
    try {
      rawData = contentType.includes("application/json") ? await request.json() : await request.text();
    } catch {
      try {
        rawData = await request.text();
      } catch {
        rawData = "";
      }
    }

    // Case 1: Pool keys into a single target provider (existing or new)
    if (rawData && typeof rawData === "object" && !Array.isArray(rawData) && (rawData.mode === "pool" || rawData.targetProviderId || (rawData.name && rawData.baseUrl && rawData.keys))) {
      const targetId = rawData.targetProviderId || rawData.id;
      let existingProvider: Provider | null = null;
      if (targetId) {
        existingProvider = await storage.getProvider(targetId);
      }

      const keysInput = rawData.keys || "";
      const poolRes = BulkIngestEngine.poolKeys(keysInput, existingProvider?.apiKey);

      if (existingProvider) {
        existingProvider.apiKey = poolRes.combinedApiKey;
        if (rawData.name) existingProvider.name = rawData.name;
        if (rawData.baseUrl) existingProvider.baseUrl = rawData.baseUrl;
        if (rawData.type) existingProvider.type = rawData.type;
        if (rawData.headers) existingProvider.headers = { ...existingProvider.headers, ...rawData.headers };
        await storage.saveProvider(existingProvider);
        return Response.json({
          success: true,
          mode: "pool",
          action: "updated",
          provider: { id: existingProvider.id, name: existingProvider.name, type: existingProvider.type, baseUrl: existingProvider.baseUrl },
          addedKeys: poolRes.addedCount,
          totalKeysInPool: poolRes.totalCount,
          durationMs: Date.now() - start,
        }, { headers: { "Access-Control-Allow-Origin": "*" } });
      } else {
        const id = rawData.id || rawData.name?.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || `prov-${Date.now().toString(36)}`;
        const newProv: Provider = {
          id,
          name: rawData.name || id,
          baseUrl: rawData.baseUrl || "https://api.openai.com/v1",
          apiKey: poolRes.combinedApiKey,
          type: rawData.type || "openai",
          headers: rawData.headers,
          enabled: true,
        };
        await storage.saveProvider(newProv);
        return Response.json({
          success: true,
          mode: "pool",
          action: "created",
          provider: { id: newProv.id, name: newProv.name, type: newProv.type, baseUrl: newProv.baseUrl },
          addedKeys: poolRes.addedCount,
          totalKeysInPool: poolRes.totalCount,
          durationMs: Date.now() - start,
        }, { headers: { "Access-Control-Allow-Origin": "*" } });
      }
    }

    // Case 2: Multi-credential parsing / Auto-detection
    const options: BulkParseOptions = typeof rawData === "object" && !Array.isArray(rawData) ? {
      defaultBaseUrl: rawData.defaultBaseUrl,
      defaultProviderType: rawData.defaultProviderType,
      namePrefix: rawData.namePrefix,
      providerPrefix: rawData.providerPrefix,
    } : {};

    const payloadToParse = typeof rawData === "object" && !Array.isArray(rawData) && rawData.keys ? rawData.keys : rawData;
    const providers = BulkIngestEngine.parseCredentials(payloadToParse, options);
    let count = 0;
    if (storage.saveProvidersBatch) {
      count = await storage.saveProvidersBatch(providers);
    } else {
      for (const p of providers) await storage.saveProvider(p);
      count = providers.length;
    }
    return Response.json({
      success: true,
      mode: "multi",
      total: providers.length,
      saved: count,
      durationMs: Date.now() - start,
    }, { headers: { "Access-Control-Allow-Origin": "*" } });
  }

  // Bulk Ingest Models into Combos
  if (path === "/api/models/bulk" && request.method === "POST") {
    if (!(await AdminAuth.verify(request))) {
      return Response.json({ error: "Unauthorized: Admin auth required" }, { status: 401, headers: { "Access-Control-Allow-Origin": "*" } });
    }
    const start = Date.now();
    const contentType = request.headers.get("content-type") || "";
    const rawData = contentType.includes("application/json") ? await request.json() : await request.text();
    const defaultProviderId = typeof rawData === "object" && rawData?.providerId ? rawData.providerId : "default-provider";
    const combos = BulkIngestEngine.parseModels(rawData, defaultProviderId);
    let count = 0;
    if (storage.saveCombosBatch) {
      count = await storage.saveCombosBatch(combos);
    } else {
      for (const c of combos) await storage.saveCombo(c);
      count = combos.length;
    }
    return Response.json({
      success: true,
      total: combos.length,
      saved: count,
      durationMs: Date.now() - start,
    }, { headers: { "Access-Control-Allow-Origin": "*" } });
  }

  // Bulk Ingest Combos directly
  if (path === "/api/combos/bulk" && request.method === "POST") {
    if (!(await AdminAuth.verify(request))) {
      return Response.json({ error: "Unauthorized: Admin auth required" }, { status: 401, headers: { "Access-Control-Allow-Origin": "*" } });
    }
    const start = Date.now();
    const body = await request.json();
    const combos = BulkIngestEngine.parseModels(body);
    let count = 0;
    if (storage.saveCombosBatch) {
      count = await storage.saveCombosBatch(combos);
    } else {
      for (const c of combos) await storage.saveCombo(c);
      count = combos.length;
    }
    return Response.json({
      success: true,
      total: combos.length,
      saved: count,
      durationMs: Date.now() - start,
    }, { headers: { "Access-Control-Allow-Origin": "*" } });
  }

  // Bulk Ingest Consumer API Keys
  if (path === "/api/keys/bulk" && request.method === "POST") {
    if (!(await AdminAuth.verify(request))) {
      return Response.json({ error: "Unauthorized: Admin auth required" }, { status: 401, headers: { "Access-Control-Allow-Origin": "*" } });
    }
    const start = Date.now();
    const body = await request.json();
    const defaultTier = typeof body === "object" && !Array.isArray(body) ? { maxRequests: body.maxRequests, maxTokens: body.maxTokens } : undefined;
    const rawKeys = Array.isArray(body) ? body : (body.keys || body.names || body.items || body);
    const keys = BulkIngestEngine.parseApiKeys(rawKeys, defaultTier);
    let count = 0;
    if (storage.saveKeysBatch) {
      count = await storage.saveKeysBatch(keys);
    } else {
      for (const k of keys) await storage.saveKey(k);
      count = keys.length;
    }
    return Response.json({
      success: true,
      total: keys.length,
      saved: count,
      keys: keys.map((k) => ({ id: k.id, name: k.name, key: k.key })),
      durationMs: Date.now() - start,
    }, { headers: { "Access-Control-Allow-Origin": "*" } });
  }

  if (path === "/api/combos" && request.method === "POST") {
    if (!(await AdminAuth.verify(request))) {
      return Response.json({ error: "Unauthorized: Admin login required" }, { status: 401, headers: { "Access-Control-Allow-Origin": "*" } });
    }
    const combo = (await request.json()) as ModelCombo;
    await storage.saveCombo(combo);
    return Response.json({ success: true, combo }, { headers: { "Access-Control-Allow-Origin": "*" } });
  }

  if (path === "/api/providers" && request.method === "GET") {
    const providers = await storage.getProviders();
    return Response.json({ providers }, { headers: { "Access-Control-Allow-Origin": "*" } });
  }

  if (path === "/api/providers" && request.method === "POST") {
    if (!(await AdminAuth.verify(request))) {
      return Response.json({ error: "Unauthorized: Admin login required" }, { status: 401, headers: { "Access-Control-Allow-Origin": "*" } });
    }
    const provider = (await request.json()) as Provider;
    await storage.saveProvider(provider);
    return Response.json({ success: true, provider }, { headers: { "Access-Control-Allow-Origin": "*" } });
  }

  if (path.startsWith("/api/providers/") && path.endsWith("/models") && request.method === "GET") {
    const id = decodeURIComponent(path.slice("/api/providers/".length, -"/models".length));
    const provider = await storage.getProvider(id);
    if (!provider) {
      return Response.json({ error: "Provider not found" }, { status: 404, headers: { "Access-Control-Allow-Origin": "*" } });
    }
    try {
      const models = await ModelDiscovery.fetchModels(provider);
      return Response.json({ models }, { headers: { "Access-Control-Allow-Origin": "*" } });
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : "Failed to fetch upstream models" },
        { status: 502, headers: { "Access-Control-Allow-Origin": "*" } }
      );
    }
  }

  if (path === "/api/providers/probe" && request.method === "POST") {
    if (!(await AdminAuth.verify(request))) {
      return Response.json({ error: "Unauthorized: Admin login required" }, { status: 401, headers: { "Access-Control-Allow-Origin": "*" } });
    }
    try {
      const body = (await request.json()) as any;
      const probeRes = await ProviderProbe.probe(body);
      return Response.json(probeRes, { headers: { "Access-Control-Allow-Origin": "*" } });
    } catch (err) {
      return Response.json({ valid: false, error: String(err) }, { status: 500, headers: { "Access-Control-Allow-Origin": "*" } });
    }
  }

  // Consumer API Keys Management
  if (path === "/api/keys" && request.method === "GET") {
    if (!(await AdminAuth.verify(request))) {
      return Response.json({ error: "Unauthorized: Admin login required" }, { status: 401, headers: { "Access-Control-Allow-Origin": "*" } });
    }
    const keys = await storage.getKeys();
    return Response.json({ keys }, { headers: { "Access-Control-Allow-Origin": "*" } });
  }

  if (path === "/api/keys" && request.method === "POST") {
    if (!(await AdminAuth.verify(request))) {
      return Response.json({ error: "Unauthorized: Admin login required" }, { status: 401, headers: { "Access-Control-Allow-Origin": "*" } });
    }
    const body = (await request.json()) as Partial<ApiKeyRecord>;
    const id = body.id || KeyManager.generateSecretKey("key_");
    const rawKey = body.key || KeyManager.generateSecretKey("er-live-");
    const keyRecord: ApiKeyRecord = {
      id,
      name: body.name || "Consumer Key",
      key: rawKey,
      createdAt: Date.now(),
      expiresAt: body.expiresAt,
      maxRequests: body.maxRequests,
      maxTokens: body.maxTokens,
      maxPromptTokens: body.maxPromptTokens,
      maxCompletionTokens: body.maxCompletionTokens,
      usedRequests: 0,
      usedTokens: 0,
      usedPromptTokens: 0,
      usedCompletionTokens: 0,
      requiredHeaders: body.requiredHeaders,
      requiredBodyKeywords: body.requiredBodyKeywords,
      allowedModels: body.allowedModels,
      enabled: body.enabled ?? true,
    };
    await storage.saveKey(keyRecord);
    return Response.json({ success: true, key: keyRecord }, { headers: { "Access-Control-Allow-Origin": "*" } });
  }

  if (path.startsWith("/api/keys/") && request.method === "DELETE") {
    if (!(await AdminAuth.verify(request))) {
      return Response.json({ error: "Unauthorized: Admin login required" }, { status: 401, headers: { "Access-Control-Allow-Origin": "*" } });
    }
    const id = decodeURIComponent(path.slice("/api/keys/".length));
    await storage.deleteKey(id);
    return Response.json({ success: true, deleted: id }, { headers: { "Access-Control-Allow-Origin": "*" } });
  }

  // Force Routing / Rewrite Rules Management
  if (path === "/api/rules" && request.method === "GET") {
    if (!(await AdminAuth.verify(request))) {
      return Response.json({ error: "Unauthorized: Admin login required" }, { status: 401, headers: { "Access-Control-Allow-Origin": "*" } });
    }
    const rules = await storage.getRules();
    return Response.json({ rules }, { headers: { "Access-Control-Allow-Origin": "*" } });
  }

  if (path === "/api/rules" && request.method === "POST") {
    if (!(await AdminAuth.verify(request))) {
      return Response.json({ error: "Unauthorized: Admin login required" }, { status: 401, headers: { "Access-Control-Allow-Origin": "*" } });
    }
    const rule = (await request.json()) as RouteRule;
    if (!rule.id) rule.id = `rule_${Date.now()}`;
    rule.enabled = rule.enabled ?? true;
    await storage.saveRule(rule);
    return Response.json({ success: true, rule }, { headers: { "Access-Control-Allow-Origin": "*" } });
  }

  if (path.startsWith("/api/rules/") && request.method === "DELETE") {
    if (!(await AdminAuth.verify(request))) {
      return Response.json({ error: "Unauthorized: Admin login required" }, { status: 401, headers: { "Access-Control-Allow-Origin": "*" } });
    }
    const id = decodeURIComponent(path.slice("/api/rules/".length));
    await storage.deleteRule(id);
    return Response.json({ success: true, deleted: id }, { headers: { "Access-Control-Allow-Origin": "*" } });
  }

  if (path.startsWith("/api/combos/") && request.method === "DELETE") {
    if (!(await AdminAuth.verify(request))) {
      return Response.json({ error: "Unauthorized: Admin login required" }, { status: 401, headers: { "Access-Control-Allow-Origin": "*" } });
    }
    const id = decodeURIComponent(path.slice("/api/combos/".length));
    await storage.deleteCombo(id);
    return Response.json({ success: true, deleted: id }, { headers: { "Access-Control-Allow-Origin": "*" } });
  }

  if (path.startsWith("/api/providers/") && request.method === "DELETE") {
    if (!(await AdminAuth.verify(request))) {
      return Response.json({ error: "Unauthorized: Admin login required" }, { status: 401, headers: { "Access-Control-Allow-Origin": "*" } });
    }
    const id = decodeURIComponent(path.slice("/api/providers/".length));
    await storage.deleteProvider(id);
    return Response.json({ success: true, deleted: id }, { headers: { "Access-Control-Allow-Origin": "*" } });
  }

  if (path === "/api/logs/clear" && request.method === "POST") {
    if (!(await AdminAuth.verify(request))) {
      return Response.json({ error: "Unauthorized: Admin login required" }, { status: 401, headers: { "Access-Control-Allow-Origin": "*" } });
    }
    await storage.clearLogs();
    return Response.json({ success: true }, { headers: { "Access-Control-Allow-Origin": "*" } });
  }

  // 4. OAuth Session JSON Importer (Kiro, Codex, Antigravity)
  if (path === "/api/oauth/import" && request.method === "POST") {
    if (!(await AdminAuth.verify(request))) {
      return Response.json({ error: "Unauthorized: Admin login required" }, { status: 401, headers: { "Access-Control-Allow-Origin": "*" } });
    }
    try {
      const { providerId, sessionJson } = (await request.json()) as { providerId: string; sessionJson: string };
      const parsedOAuth = OAuthManager.parseSessionJson(sessionJson);
      const existing = await storage.getProvider(providerId);

      if (!existing) {
        return Response.json({ error: "Provider not found" }, { status: 404 });
      }

      existing.oauth = {
        ...existing.oauth,
        ...parsedOAuth,
        type: parsedOAuth.type || "session_json",
      };

      await storage.saveProvider(existing);
      return Response.json({ success: true, message: `OAuth session imported for ${providerId}` });
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Import failed" }, { status: 400 });
    }
  }

  // 5. Public Landing Page at root (/)
  if (path === "/" || path === "/index.html") {
    return new Response(PUBLIC_LANDING_HTML, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // 6. Admin Management Console (/admin or /admin/*)
  if (path === "/admin" || path.startsWith("/admin/") || path === "/dashboard") {
    return new Response(DASHBOARD_HTML, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  return new Response("Not Found", { status: 404 });
}

// Bun Native Server entrypoint
const port = Number(process.env.PORT || 20129);
const hostname = process.env.HOST || "0.0.0.0";

const server = Bun.serve({
  port,
  hostname,
  idleTimeout: 120, // 2 minutes for slow upstreams & deep reasoning models
  fetch: handleRequest,
});

console.log(`🚀 EdgeRouter running on http://${server.hostname}:${server.port}`);
