// Cloudflare Workers Native Serverless Entrypoint
import { EdgeRouter } from "./core/router";
import { D1StorageAdapter, type D1Database } from "./storage/d1";
import { TursoStorageAdapter } from "./storage/turso";
import { MemoryStorageAdapter, type StorageAdapter } from "./storage";
import { ModelDiscovery } from "./core/discovery";
import { OAuthManager } from "./core/oauth";
import { AdminAuth } from "./core/auth";
import { ProviderProbe } from "./core/probe";
import { KeyManager, type ApiKeyRecord } from "./core/keys";
import { BulkIngestEngine } from "./core/bulk";
import type { RouteRule } from "./core/rewrite";
import type { ChatCompletionRequest, ModelCombo, Provider } from "./types";
import { DASHBOARD_HTML } from "./dashboardHtml";
import { PUBLIC_LANDING_HTML } from "./landingHtml";

export interface Env {
  DB?: D1Database;
  TURSO_DATABASE_URL?: string;
  TURSO_AUTH_TOKEN?: string;
  ADMIN_PASSWORD?: string;
  MASTER_KEY?: string;
}

export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

// Initial seed data for fresh edge deployments
const seedProviders: Provider[] = [
  {
    id: "gemini-studio",
    name: "Google AI Studio",
    baseUrl: "https://generativelanguage.googleapis.com",
    type: "gemini",
    enabled: true,
  },
  {
    id: "anthropic-official",
    name: "Anthropic Claude",
    baseUrl: "https://api.anthropic.com",
    type: "anthropic",
    enabled: true,
  },
];

const seedCombos: ModelCombo[] = [
  {
    id: "fast-tier",
    displayName: "Fast Tier (Gemini Flash)",
    description: "Ultra low latency 1M context",
    enabled: true,
    targets: [{ providerId: "gemini-studio", model: "gemini-1.5-flash", priority: 10 }],
  },
  {
    id: "smart-tier",
    displayName: "Smart Tier (Claude Sonnet)",
    description: "Deep reasoning & coding flagship",
    enabled: true,
    targets: [{ providerId: "anthropic-official", model: "claude-3-5-sonnet-20241022", priority: 10 }],
  },
];

let cachedStorage: StorageAdapter | null = null;
let cachedRouter: EdgeRouter | null = null;
let initialized = false;

async function getRouter(env: Env): Promise<{ router: EdgeRouter; storage: StorageAdapter }> {
  if (cachedRouter && cachedStorage) {
    return { router: cachedRouter, storage: cachedStorage };
  }

  let storage: StorageAdapter;
  if (env.TURSO_DATABASE_URL && env.TURSO_AUTH_TOKEN) {
    const turso = new TursoStorageAdapter(env.TURSO_DATABASE_URL, env.TURSO_AUTH_TOKEN);
    try {
      await turso.initSchema();
    } catch {}
    storage = turso;
  } else if (env.DB) {
    storage = new D1StorageAdapter(env.DB);
  } else {
    storage = new MemoryStorageAdapter();
  }

  if (!initialized) {
    const existing = await storage.getCombos();
    if (existing.length === 0) {
      for (const p of seedProviders) await storage.saveProvider(p);
      for (const c of seedCombos) await storage.saveCombo(c);
    }
    initialized = true;
  }

  const router = new EdgeRouter(storage);
  cachedStorage = storage;
  cachedRouter = router;

  return { router, storage };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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

    const { router, storage } = await getRouter(env);

    // 1. OpenAI Chat Completions & Models
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
        const authRes = await AdminAuth.login(password || "", env.ADMIN_PASSWORD);
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

    // 3. REST Management APIs
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
      return Response.json({ status: "healthy", runtime: "cloudflare-worker", metrics, logs, timeframe: timeframe || "all" }, { headers: { "Access-Control-Allow-Origin": "*" } });
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

    // Bulk Ingest Providers (API keys, OAuth, Cookie sessions)
    if (path === "/api/providers/bulk" && request.method === "POST") {
      if (!(await AdminAuth.verify(request, env.ADMIN_PASSWORD))) {
        return Response.json({ error: "Unauthorized: Admin auth required" }, { status: 401, headers: { "Access-Control-Allow-Origin": "*" } });
      }
      const start = Date.now();
      const contentType = request.headers.get("content-type") || "";
      const rawData = contentType.includes("application/json") ? await request.json() : await request.text();
      const providers = BulkIngestEngine.parseCredentials(rawData);
      let count = 0;
      if (storage.saveProvidersBatch) {
        count = await storage.saveProvidersBatch(providers);
      } else {
        for (const p of providers) await storage.saveProvider(p);
        count = providers.length;
      }
      return Response.json({
        success: true,
        total: providers.length,
        saved: count,
        durationMs: Date.now() - start,
      }, { headers: { "Access-Control-Allow-Origin": "*" } });
    }

    // Bulk Ingest Models into Combos
    if (path === "/api/models/bulk" && request.method === "POST") {
      if (!(await AdminAuth.verify(request, env.ADMIN_PASSWORD))) {
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
      if (!(await AdminAuth.verify(request, env.ADMIN_PASSWORD))) {
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
      if (!(await AdminAuth.verify(request, env.ADMIN_PASSWORD))) {
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

    if (path.startsWith("/api/combos/") && request.method === "DELETE") {
      if (!(await AdminAuth.verify(request))) {
        return Response.json({ error: "Unauthorized: Admin login required" }, { status: 401, headers: { "Access-Control-Allow-Origin": "*" } });
      }
      const id = decodeURIComponent(path.slice("/api/combos/".length));
      await storage.deleteCombo(id);
      return Response.json({ success: true, deleted: id }, { headers: { "Access-Control-Allow-Origin": "*" } });
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

    if (path.startsWith("/api/providers/") && request.method === "DELETE") {
      if (!(await AdminAuth.verify(request))) {
        return Response.json({ error: "Unauthorized: Admin login required" }, { status: 401, headers: { "Access-Control-Allow-Origin": "*" } });
      }
      const id = decodeURIComponent(path.slice("/api/providers/".length));
      await storage.deleteProvider(id);
      return Response.json({ success: true, deleted: id }, { headers: { "Access-Control-Allow-Origin": "*" } });
    }

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

    if (path === "/api/providers/probe" && request.method === "POST") {
      if (!(await AdminAuth.verify(request))) {
        return Response.json({ error: "Unauthorized: Admin login required" }, { status: 401, headers: { "Access-Control-Allow-Origin": "*" } });
      }
      try {
        const body = (await request.json()) as { baseUrl: string; apiKey?: string; type?: "openai" | "gemini" | "anthropic" };
        const result = await ProviderProbe.probe(body);
        return Response.json(result, { headers: { "Access-Control-Allow-Origin": "*" } });
      } catch (err) {
        return Response.json({ valid: false, statusCode: 0, latencyMs: 0, error: String(err) }, { status: 500, headers: { "Access-Control-Allow-Origin": "*" } });
      }
    }

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
      const record: ApiKeyRecord = {
        id,
        name: body.name || "Default Key",
        key: rawKey,
        createdAt: body.createdAt || Date.now(),
        expiresAt: body.expiresAt,
        maxRequests: body.maxRequests,
        maxTokens: body.maxTokens,
        maxPromptTokens: body.maxPromptTokens,
        maxCompletionTokens: body.maxCompletionTokens,
        usedRequests: body.usedRequests || 0,
        usedTokens: body.usedTokens || 0,
        usedPromptTokens: body.usedPromptTokens || 0,
        usedCompletionTokens: body.usedCompletionTokens || 0,
        requiredHeaders: body.requiredHeaders,
        requiredBodyKeywords: body.requiredBodyKeywords,
        allowedModels: body.allowedModels,
        enabled: body.enabled ?? true,
      };
      await storage.saveKey(record);
      return Response.json({ success: true, key: record }, { headers: { "Access-Control-Allow-Origin": "*" } });
    }

    if (path.startsWith("/api/keys/") && request.method === "DELETE") {
      if (!(await AdminAuth.verify(request))) {
        return Response.json({ error: "Unauthorized: Admin login required" }, { status: 401, headers: { "Access-Control-Allow-Origin": "*" } });
      }
      const id = decodeURIComponent(path.slice("/api/keys/".length));
      await storage.deleteKey(id);
      return Response.json({ success: true, deleted: id }, { headers: { "Access-Control-Allow-Origin": "*" } });
    }

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

    if (path === "/api/logs/clear" && request.method === "POST") {
      if (!(await AdminAuth.verify(request))) {
        return Response.json({ error: "Unauthorized: Admin login required" }, { status: 401, headers: { "Access-Control-Allow-Origin": "*" } });
      }
      await storage.clearLogs();
      return Response.json({ success: true }, { headers: { "Access-Control-Allow-Origin": "*" } });
    }

    // 4. Public Landing Page at root (/)
    if (path === "/" || path === "/index.html") {
      return new Response(PUBLIC_LANDING_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // 5. Admin Management Console (/admin or /admin/*)
    if (path === "/admin" || path.startsWith("/admin/") || path === "/dashboard") {
      return new Response(DASHBOARD_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
};
