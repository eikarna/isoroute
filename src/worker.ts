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
import { BulkIngestEngine, type BulkParseOptions } from "./core/bulk";
import { BackupEngine } from "./core/backup";
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
      const authHeader = request.headers.get("Authorization");
      let clientKey = "";
      if (authHeader && authHeader.startsWith("Bearer ")) {
        clientKey = authHeader.slice(7).trim();
      }

      const allKeys = await storage.getKeys();
      let matchedApiKey: ApiKeyRecord | null = null;
      let isAdmin = false;

      if (clientKey) {
        if (env.ADMIN_PASSWORD && clientKey === env.ADMIN_PASSWORD) {
          isAdmin = true;
        } else if (await AdminAuth.verify(request, env.ADMIN_PASSWORD)) {
          isAdmin = true;
        } else {
          matchedApiKey = await storage.getKey(clientKey);
        }
      } else if (await AdminAuth.verify(request, env.ADMIN_PASSWORD)) {
        isAdmin = true;
      }

      // If consumer keys exist in system, enforce authentication
      if (allKeys.length > 0 && !isAdmin) {
        if (!matchedApiKey) {
          return Response.json(
            { error: { message: "Invalid or missing API key", type: "authentication_error", code: 401 } },
            { status: 401, headers: { "Access-Control-Allow-Origin": "*" } }
          );
        }
        if (!matchedApiKey.enabled) {
          return Response.json(
            { error: { message: "API key is disabled", type: "permission_error", code: 403 } },
            { status: 403, headers: { "Access-Control-Allow-Origin": "*" } }
          );
        }
        if (matchedApiKey.expiresAt && matchedApiKey.expiresAt > 0 && Date.now() > matchedApiKey.expiresAt) {
          return Response.json(
            { error: { message: "API key has expired", type: "permission_error", code: 403 } },
            { status: 403, headers: { "Access-Control-Allow-Origin": "*" } }
          );
        }
      }

      let combos = await storage.getCombos();
      combos = combos.filter((c) => c.enabled !== false);

      // Scoped Model Isolation: Only expose models authorized for this consumer key!
      if (matchedApiKey && matchedApiKey.allowedModels && matchedApiKey.allowedModels.length > 0) {
        combos = combos.filter((c) => {
          return matchedApiKey!.allowedModels!.some((pattern) => {
            try {
              const regex = RewriteEngine.compilePattern(pattern.trim());
              return regex.test(c.id);
            } catch {
              return pattern.trim() === c.id;
            }
          });
        });
      }

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
      const q = url.searchParams.get("q")?.toLowerCase().trim();
      let combos = await storage.getCombos();
      if (q) {
        combos = combos.filter(
          (c) =>
            c.id.toLowerCase().includes(q) ||
            c.displayName.toLowerCase().includes(q) ||
            c.targets.some((t) => t.providerId.toLowerCase().includes(q) || t.model.toLowerCase().includes(q))
        );
      }
      return Response.json({ combos, total: combos.length }, { headers: { "Access-Control-Allow-Origin": "*" } });
    }

    // Headless Model & Combo Discovery API (9Router parity)
    if (path === "/api/models" && request.method === "GET") {
      const q = url.searchParams.get("q")?.toLowerCase().trim();
      let combos = await storage.getCombos();
      const providers = await storage.getProviders();
      if (q) {
        combos = combos.filter(
          (c) =>
            c.id.toLowerCase().includes(q) ||
            c.displayName.toLowerCase().includes(q) ||
            c.targets.some((t) => t.providerId.toLowerCase().includes(q) || t.model.toLowerCase().includes(q))
        );
      }
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

    // Full Configuration Export
    if (path === "/api/config/export" && request.method === "GET") {
      if (!(await AdminAuth.verify(request, env.ADMIN_PASSWORD))) {
        return Response.json({ error: "Unauthorized: Admin auth required" }, { status: 401, headers: { "Access-Control-Allow-Origin": "*" } });
      }
      const backup = await BackupEngine.exportConfig(storage);
      const filename = `isoroute-config-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
      return Response.json(backup, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Content-Disposition": `attachment; filename="${filename}"`,
        },
      });
    }

    // Full Configuration Import (IsoRoute native or 9Router backup)
    if (path === "/api/config/import" && request.method === "POST") {
      if (!(await AdminAuth.verify(request, env.ADMIN_PASSWORD))) {
        return Response.json({ error: "Unauthorized: Admin auth required" }, { status: 401, headers: { "Access-Control-Allow-Origin": "*" } });
      }
      try {
        const mode = (url.searchParams.get("mode") as "merge" | "replace") || "merge";
        const contentType = request.headers.get("content-type") || "";
        let payload: any;
        if (contentType.includes("application/json")) {
          payload = await request.json();
        } else {
          payload = await request.text();
        }
        const result = await BackupEngine.importConfig(storage, payload, mode);
        return Response.json(result, { headers: { "Access-Control-Allow-Origin": "*" } });
      } catch (err: any) {
        return Response.json({ success: false, error: err.message }, { status: 400, headers: { "Access-Control-Allow-Origin": "*" } });
      }
    }

    // Bulk Ingest Providers (API keys, OAuth, Cookie sessions, or Key Pooling)
    if (path === "/api/providers/bulk" && request.method === "POST") {
      if (!(await AdminAuth.verify(request, env.ADMIN_PASSWORD))) {
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
      if (!(await AdminAuth.verify(request, env.ADMIN_PASSWORD))) {
        return Response.json({ error: "Unauthorized: Admin login required" }, { status: 401, headers: { "Access-Control-Allow-Origin": "*" } });
      }
      const combo = (await request.json()) as ModelCombo;
      await storage.saveCombo(combo);
      return Response.json({ success: true, combo }, { headers: { "Access-Control-Allow-Origin": "*" } });
    }

    if (path.startsWith("/api/combos/") && request.method === "PUT") {
      if (!(await AdminAuth.verify(request, env.ADMIN_PASSWORD))) {
        return Response.json({ error: "Unauthorized: Admin login required" }, { status: 401, headers: { "Access-Control-Allow-Origin": "*" } });
      }
      const id = decodeURIComponent(path.slice("/api/combos/".length));
      const existing = await storage.getCombo(id);
      if (!existing) {
        return Response.json({ error: `Combo '${id}' not found` }, { status: 404, headers: { "Access-Control-Allow-Origin": "*" } });
      }
      const body = (await request.json()) as Partial<ModelCombo>;
      const updated: ModelCombo = {
        ...existing,
        displayName: body.displayName !== undefined ? body.displayName : existing.displayName,
        description: body.description !== undefined ? body.description : existing.description,
        targets: body.targets !== undefined ? body.targets : existing.targets,
        strategy: body.strategy !== undefined ? body.strategy : existing.strategy,
        enabled: body.enabled !== undefined ? body.enabled : existing.enabled,
      };
      await storage.saveCombo(updated);
      return Response.json({ success: true, combo: updated }, { headers: { "Access-Control-Allow-Origin": "*" } });
    }

    if (path.startsWith("/api/combos/") && request.method === "DELETE") {
      if (!(await AdminAuth.verify(request, env.ADMIN_PASSWORD))) {
        return Response.json({ error: "Unauthorized: Admin login required" }, { status: 401, headers: { "Access-Control-Allow-Origin": "*" } });
      }
      const id = decodeURIComponent(path.slice("/api/combos/".length));
      await storage.deleteCombo(id);
      return Response.json({ success: true, deleted: id }, { headers: { "Access-Control-Allow-Origin": "*" } });
    }

    if (path === "/api/providers" && request.method === "GET") {
      const q = url.searchParams.get("q")?.toLowerCase().trim();
      let providers = await storage.getProviders();
      if (q) {
        providers = providers.filter(
          (p) =>
            p.id.toLowerCase().includes(q) ||
            p.name.toLowerCase().includes(q) ||
            p.type.toLowerCase().includes(q) ||
            p.baseUrl.toLowerCase().includes(q)
        );
      }
      return Response.json({ providers, total: providers.length }, { headers: { "Access-Control-Allow-Origin": "*" } });
    }

    if ((path === "/api/providers" && request.method === "POST") || (path.startsWith("/api/providers/") && !path.endsWith("/models") && request.method === "PUT")) {
      if (!(await AdminAuth.verify(request, env.ADMIN_PASSWORD))) {
        return Response.json({ error: "Unauthorized: Admin login required" }, { status: 401, headers: { "Access-Control-Allow-Origin": "*" } });
      }
      const body = (await request.json()) as Partial<Provider>;
      let id = body.id;
      if (path.startsWith("/api/providers/")) {
        id = decodeURIComponent(path.slice("/api/providers/".length));
      }
      if (!id) {
        return Response.json({ error: "Provider ID required" }, { status: 400, headers: { "Access-Control-Allow-Origin": "*" } });
      }
      const existing = await storage.getProvider(id);
      const provider: Provider = {
        id: id.trim().toLowerCase(),
        name: body.name ?? existing?.name ?? id,
        baseUrl: body.baseUrl ?? existing?.baseUrl ?? "",
        apiKey: body.apiKey !== undefined ? body.apiKey : existing?.apiKey,
        type: body.type ?? existing?.type ?? "openai",
        headers: body.headers ?? existing?.headers,
        oauth: body.oauth ?? existing?.oauth,
        enabled: body.enabled !== undefined ? body.enabled : (existing?.enabled ?? true),
        keyStrategy: body.keyStrategy ?? existing?.keyStrategy ?? "fallback",
        stickyCount: body.stickyCount ? Math.max(1, Number(body.stickyCount)) : (existing?.stickyCount ?? 1),
      };
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
      if (!(await AdminAuth.verify(request, env.ADMIN_PASSWORD))) {
        return Response.json({ error: "Unauthorized: Admin login required" }, { status: 401, headers: { "Access-Control-Allow-Origin": "*" } });
      }
      const id = decodeURIComponent(path.slice("/api/providers/".length));
      await storage.deleteProvider(id);
      return Response.json({ success: true, deleted: id }, { headers: { "Access-Control-Allow-Origin": "*" } });
    }

    if (path === "/api/oauth/import" && request.method === "POST") {
      if (!(await AdminAuth.verify(request, env.ADMIN_PASSWORD))) {
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
      if (!(await AdminAuth.verify(request, env.ADMIN_PASSWORD))) {
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
      if (!(await AdminAuth.verify(request, env.ADMIN_PASSWORD))) {
        return Response.json({ error: "Unauthorized: Admin login required" }, { status: 401, headers: { "Access-Control-Allow-Origin": "*" } });
      }
      const q = url.searchParams.get("q")?.toLowerCase().trim();
      let keys = await storage.getKeys();
      if (q) {
        keys = keys.filter(
          (k) =>
            k.name.toLowerCase().includes(q) ||
            k.key.toLowerCase().includes(q) ||
            (k.allowedModels && k.allowedModels.some((m) => m.toLowerCase().includes(q)))
        );
      }
      return Response.json({ keys, total: keys.length }, { headers: { "Access-Control-Allow-Origin": "*" } });
    }

    if (path === "/api/keys" && request.method === "POST") {
      if (!(await AdminAuth.verify(request, env.ADMIN_PASSWORD))) {
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

    if (path.startsWith("/api/keys/") && request.method === "PUT") {
      if (!(await AdminAuth.verify(request, env.ADMIN_PASSWORD))) {
        return Response.json({ error: "Unauthorized: Admin login required" }, { status: 401, headers: { "Access-Control-Allow-Origin": "*" } });
      }
      const id = decodeURIComponent(path.slice("/api/keys/".length));
      const existing = await storage.getKey(id);
      if (!existing) {
        return Response.json({ error: `Key '${id}' not found` }, { status: 404, headers: { "Access-Control-Allow-Origin": "*" } });
      }
      const body = (await request.json()) as Partial<ApiKeyRecord>;
      const updated: ApiKeyRecord = {
        ...existing,
        name: body.name !== undefined ? body.name : existing.name,
        expiresAt: body.expiresAt !== undefined ? (body.expiresAt === null ? undefined : body.expiresAt) : existing.expiresAt,
        maxRequests: body.maxRequests !== undefined ? (body.maxRequests === null ? undefined : body.maxRequests) : existing.maxRequests,
        maxTokens: body.maxTokens !== undefined ? (body.maxTokens === null ? undefined : body.maxTokens) : existing.maxTokens,
        maxPromptTokens: body.maxPromptTokens !== undefined ? (body.maxPromptTokens === null ? undefined : body.maxPromptTokens) : existing.maxPromptTokens,
        maxCompletionTokens: body.maxCompletionTokens !== undefined ? (body.maxCompletionTokens === null ? undefined : body.maxCompletionTokens) : existing.maxCompletionTokens,
        usedRequests: body.usedRequests !== undefined ? body.usedRequests : existing.usedRequests,
        usedTokens: body.usedTokens !== undefined ? body.usedTokens : existing.usedTokens,
        usedPromptTokens: body.usedPromptTokens !== undefined ? body.usedPromptTokens : existing.usedPromptTokens,
        usedCompletionTokens: body.usedCompletionTokens !== undefined ? body.usedCompletionTokens : existing.usedCompletionTokens,
        allowedModels: body.allowedModels !== undefined ? body.allowedModels : existing.allowedModels,
        requiredHeaders: body.requiredHeaders !== undefined ? body.requiredHeaders : existing.requiredHeaders,
        requiredBodyKeywords: body.requiredBodyKeywords !== undefined ? body.requiredBodyKeywords : existing.requiredBodyKeywords,
        enabled: body.enabled !== undefined ? body.enabled : existing.enabled,
      };
      await storage.saveKey(updated);
      return Response.json({ success: true, key: updated }, { headers: { "Access-Control-Allow-Origin": "*" } });
    }

    if (path.startsWith("/api/keys/") && request.method === "DELETE") {
      if (!(await AdminAuth.verify(request, env.ADMIN_PASSWORD))) {
        return Response.json({ error: "Unauthorized: Admin login required" }, { status: 401, headers: { "Access-Control-Allow-Origin": "*" } });
      }
      const id = decodeURIComponent(path.slice("/api/keys/".length));
      await storage.deleteKey(id);
      return Response.json({ success: true, deleted: id }, { headers: { "Access-Control-Allow-Origin": "*" } });
    }

    if (path === "/api/rules" && request.method === "GET") {
      if (!(await AdminAuth.verify(request, env.ADMIN_PASSWORD))) {
        return Response.json({ error: "Unauthorized: Admin login required" }, { status: 401, headers: { "Access-Control-Allow-Origin": "*" } });
      }
      const q = url.searchParams.get("q")?.toLowerCase().trim();
      let rules = await storage.getRules();
      if (q) {
        rules = rules.filter(
          (r) =>
            r.pattern.toLowerCase().includes(q) ||
            r.target.toLowerCase().includes(q)
        );
      }
      return Response.json({ rules, total: rules.length }, { headers: { "Access-Control-Allow-Origin": "*" } });
    }

    if (path === "/api/rules" && request.method === "POST") {
      if (!(await AdminAuth.verify(request, env.ADMIN_PASSWORD))) {
        return Response.json({ error: "Unauthorized: Admin login required" }, { status: 401, headers: { "Access-Control-Allow-Origin": "*" } });
      }
      const rule = (await request.json()) as RouteRule;
      if (!rule.id) rule.id = `rule_${Date.now()}`;
      rule.enabled = rule.enabled ?? true;
      await storage.saveRule(rule);
      return Response.json({ success: true, rule }, { headers: { "Access-Control-Allow-Origin": "*" } });
    }

    if (path.startsWith("/api/rules/") && request.method === "DELETE") {
      if (!(await AdminAuth.verify(request, env.ADMIN_PASSWORD))) {
        return Response.json({ error: "Unauthorized: Admin login required" }, { status: 401, headers: { "Access-Control-Allow-Origin": "*" } });
      }
      const id = decodeURIComponent(path.slice("/api/rules/".length));
      await storage.deleteRule(id);
      return Response.json({ success: true, deleted: id }, { headers: { "Access-Control-Allow-Origin": "*" } });
    }

    if (path === "/api/logs/clear" && request.method === "POST") {
      if (!(await AdminAuth.verify(request, env.ADMIN_PASSWORD))) {
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
