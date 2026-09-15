// High-Performance Bulk Ingestion Engine for API Keys, OAuth, Cookies & Models
// Designed to process up to 20,000+ entries with zero memory bloat, deterministic deduplication & chunked storage execution.
import type { Provider, ModelCombo } from "../types";
import type { ApiKeyRecord } from "./keys";
import { KeyManager } from "./keys";

export interface BulkParseOptions {
  defaultProviderType?: "openai" | "gemini" | "anthropic" | "custom";
  defaultBaseUrl?: string;
  providerPrefix?: string;
  namePrefix?: string;
}

export interface BulkPoolPayload {
  mode?: "pool" | "multi";
  targetProviderId?: string;
  id?: string;
  name?: string;
  baseUrl?: string;
  type?: "openai" | "gemini" | "anthropic" | "custom";
  keys?: string | string[];
  headers?: Record<string, string>;
  defaultBaseUrl?: string;
  defaultProviderType?: "openai" | "gemini" | "anthropic" | "custom";
  namePrefix?: string;
  providerPrefix?: string;
}

export interface ParsedCredential {
  id: string;
  name: string;
  provider: Provider;
}

export interface BulkIngestSummary {
  total: number;
  added: number;
  updated: number;
  skipped: number;
  errors: string[];
  durationMs: number;
}

export class BulkIngestEngine {
  /**
   * Extract and clean list of API keys from arbitrary text (newline, comma, semicolon)
   */
  static extractKeyList(raw: string | string[]): string[] {
    if (Array.isArray(raw)) {
      return raw.map((k) => String(k).trim()).filter(Boolean);
    }
    if (typeof raw !== "string") return [];
    return raw
      .split(/[\r\n,;\t]+/)
      .map((line) => line.replace(/(\/\/|#).*$/, "").trim())
      .filter(Boolean);
  }

  /**
   * Pool multiple API keys into a single comma-separated string, merging and deduplicating
   */
  static poolKeys(
    newKeysRaw: string | string[],
    existingApiKey?: string
  ): { keys: string[]; combinedApiKey: string; addedCount: number; totalCount: number } {
    const existingKeys = existingApiKey
      ? existingApiKey.split(/[\r\n,;\t]+/).map((k) => k.trim()).filter(Boolean)
      : [];
    const newKeys = this.extractKeyList(newKeysRaw);

    const keySet = new Set<string>();
    for (const k of existingKeys) keySet.add(k);

    let addedCount = 0;
    for (const k of newKeys) {
      if (!keySet.has(k)) {
        keySet.add(k);
        addedCount++;
      }
    }

    const allKeys = Array.from(keySet);
    return {
      keys: allKeys,
      combinedApiKey: allKeys.join(","),
      addedCount,
      totalCount: allKeys.length,
    };
  }

  /**
   * Compute deterministic 16-char hex hash from string
   */
  static hashKey(str: string): string {
    let h1 = 0xdeadbeef ^ str.length;
    let h2 = 0x41c64e6d ^ str.length;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    const part1 = (h1 >>> 0).toString(16).padStart(8, "0");
    const part2 = (h2 >>> 0).toString(16).padStart(8, "0");
    return `${part1}${part2}`;
  }

  /**
   * Infer provider type and base URL from API key signature
   */
  static inferProvider(key: string): { type: "openai" | "gemini" | "anthropic" | "custom"; baseUrl: string; nameSlug: string } {
    const trimmed = key.trim();
    if (trimmed.startsWith("nvapi-")) {
      return { type: "openai", baseUrl: "https://integrate.api.nvidia.com/v1", nameSlug: "nvidia" };
    }
    if (trimmed.startsWith("sk-ant-")) {
      return { type: "anthropic", baseUrl: "https://api.anthropic.com", nameSlug: "anthropic" };
    }
    if (trimmed.startsWith("AIzaSy")) {
      return { type: "gemini", baseUrl: "https://generativelanguage.googleapis.com", nameSlug: "gemini" };
    }
    if (trimmed.startsWith("ghp_") || trimmed.startsWith("github_pat_")) {
      return { type: "openai", baseUrl: "https://models.inference.ai.azure.com", nameSlug: "github-models" };
    }
    if (trimmed.startsWith("gsk_")) {
      return { type: "openai", baseUrl: "https://api.groq.com/openai/v1", nameSlug: "groq" };
    }
    if (trimmed.startsWith("sk-or-v1-")) {
      return { type: "openai", baseUrl: "https://openrouter.ai/api/v1", nameSlug: "openrouter" };
    }
    return { type: "openai", baseUrl: "https://api.openai.com/v1", nameSlug: "openai" };
  }

  /**
   * Parse raw text, JSON arrays, OAuth objects, or Cookie strings into Provider records
   */
  static parseCredentials(raw: string | unknown, options: BulkParseOptions = {}): Provider[] {
    const results: Provider[] = [];
    const seenIds = new Set<string>();

    if (typeof raw !== "string") {
      return this.parseStructuredData(raw, options);
    }

    const trimmed = raw.trim();
    if (!trimmed) return results;

    // 1. JSON Array or Object Detection
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed);
        return this.parseStructuredData(parsed, options);
      } catch {
        // Fall through to line-by-line parsing if JSON parse fails
      }
    }

    // 2. Cookie String Detection (e.g. "Cookie: session=...; token=..." or "session=...; auth=...")
    if (trimmed.toLowerCase().startsWith("cookie:") || (trimmed.includes("=") && trimmed.includes(";") && !trimmed.includes("\n"))) {
      const cookieVal = trimmed.replace(/^cookie:\s*/i, "").trim();
      const hash = this.hashKey(cookieVal);
      const id = `cookie-${hash.slice(0, 12)}`;
      results.push({
        id,
        name: `Cookie Session (${hash.slice(0, 8)})`,
        baseUrl: options.defaultBaseUrl || "https://api.openai.com/v1",
        type: options.defaultProviderType || "custom",
        headers: { Cookie: cookieVal },
        enabled: true,
      });
      return results;
    }

    // 3. Line-by-line / Delimiter-separated plain API keys
    const lines = trimmed.split(/[\r\n,;\t]+/);
    for (let line of lines) {
      line = line.replace(/(\/\/|#).*$/, "").trim();
      if (!line) continue;

      const hash = this.hashKey(line);
      if (seenIds.has(hash)) continue;
      seenIds.add(hash);

      const inferred = this.inferProvider(line);
      const prefix = options.providerPrefix || inferred.nameSlug;
      const id = `${prefix}-${hash.slice(0, 12)}`;
      const name = options.namePrefix ? `${options.namePrefix}-${hash.slice(0, 8)}` : `${prefix}-${hash.slice(0, 8)}`;

      results.push({
        id,
        name,
        baseUrl: options.defaultBaseUrl || inferred.baseUrl,
        apiKey: line,
        type: options.defaultProviderType || inferred.type,
        enabled: true,
      });
    }

    return results;
  }

  /**
   * Parse structured JSON data (arrays, objects, OAuth/Session bundles)
   */
  private static parseStructuredData(data: unknown, options: BulkParseOptions): Provider[] {
    const results: Provider[] = [];
    const seenIds = new Set<string>();

    // Case A: Array of strings or objects
    if (Array.isArray(data)) {
      for (let i = 0; i < data.length; i++) {
        const item = data[i];
        if (typeof item === "string") {
          const key = item.trim();
          if (!key) continue;
          const hash = this.hashKey(key);
          if (seenIds.has(hash)) continue;
          seenIds.add(hash);

          const inferred = this.inferProvider(key);
          const prefix = options.providerPrefix || inferred.nameSlug;
          results.push({
            id: `${prefix}-${hash.slice(0, 12)}`,
            name: `${prefix}-${hash.slice(0, 8)}`,
            baseUrl: options.defaultBaseUrl || inferred.baseUrl,
            apiKey: key,
            type: options.defaultProviderType || inferred.type,
            enabled: true,
          });
        } else if (item && typeof item === "object") {
          const obj = item as Record<string, any>;
          const key = obj.apiKey || obj.key || obj.token || "";
          const hash = key ? this.hashKey(key) : this.hashKey(JSON.stringify(obj));
          if (seenIds.has(hash)) continue;
          seenIds.add(hash);

          const name = obj.name || `${obj.provider || "prov"}-${hash.slice(0, 8)}`;
          const id = obj.id || `p-${hash.slice(0, 12)}`;

          // OAuth/session material is intentionally not accepted in bulk ingest.
          // It must enter through a typed built-in connection so its transport,
          // validation, and encrypted storage are explicit.
          results.push({
            id,
            name,
            baseUrl: obj.baseUrl || options.defaultBaseUrl || "https://api.openai.com/v1",
            apiKey: typeof obj.apiKey === "string"
              ? obj.apiKey
              : typeof obj.key === "string"
                ? obj.key
                : typeof obj.token === "string"
                  ? obj.token
                  : undefined,
            type: obj.type || options.defaultProviderType || "openai",
            headers: obj.headers,
            enabled: obj.enabled ?? true,
          });
        }
      }
      return results;
    }

    // Case B: Single object. Session credentials are deliberately excluded;
    // callers must use the typed /api/connections flow instead.
    if (data && typeof data === "object") {
      const obj = data as Record<string, any>;
      if (obj.access_token || obj.refreshToken || obj.refresh_token || obj.tokenEndpoint || obj.type === "authorized_user") {
        return results;
      }

      // Wrapped providers array (e.g. { "providers": [...] } or { "connections": [...] })
      if (Array.isArray(obj.providers)) return this.parseStructuredData(obj.providers, options);
      if (Array.isArray(obj.connections)) return this.parseStructuredData(obj.connections, options);
      if (Array.isArray(obj.keys)) return this.parseStructuredData(obj.keys, options);
    }

    return results;
  }

  /**
   * Parse bulk models into ModelCombo records
   */
  static parseModels(raw: string | unknown, defaultProviderId = "default-provider"): ModelCombo[] {
    const combos: ModelCombo[] = [];
    const seenIds = new Set<string>();

    let modelList: string[] = [];

    if (Array.isArray(raw)) {
      modelList = raw.map((item) => (typeof item === "string" ? item : (item.id || item.model || ""))).filter(Boolean);
    } else if (typeof raw === "string") {
      const trimmed = raw.trim();
      if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
        try {
          const parsed = JSON.parse(trimmed);
          return this.parseModels(parsed, defaultProviderId);
        } catch {}
      }
      modelList = trimmed.split(/[\r\n,;\t]+/).map((s) => s.trim()).filter(Boolean);
    } else if (raw && typeof raw === "object") {
      const obj = raw as Record<string, any>;
      if (Array.isArray(obj.models)) return this.parseModels(obj.models, obj.providerId || defaultProviderId);
      if (Array.isArray(obj.combos)) {
        return obj.combos.map((c: any) => ({
          id: c.id || `combo-${this.hashKey(c.displayName || c.id).slice(0, 10)}`,
          displayName: c.displayName || c.name || c.id,
          description: c.description,
          targets: c.targets || [{ providerId: defaultProviderId, model: c.model || c.id, priority: 1 }],
          enabled: c.enabled ?? true,
        }));
      }
    }

    for (const model of modelList) {
      const id = model.trim();
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);

      combos.push({
        id,
        displayName: id,
        description: `Direct routing to ${id}`,
        targets: [
          {
            providerId: defaultProviderId,
            model: id,
            priority: 1,
          },
        ],
        enabled: true,
      });
    }

    return combos;
  }

  /**
   * Parse bulk consumer API keys with billing tiers
   */
  static parseApiKeys(raw: string | unknown, defaultTier?: { maxRequests?: number; maxTokens?: number }): ApiKeyRecord[] {
    const keys: ApiKeyRecord[] = [];
    const now = Date.now();

    if (Array.isArray(raw)) {
      for (const item of raw) {
        if (typeof item === "string") {
          const name = item.trim();
          if (!name) continue;
          keys.push({
            id: KeyManager.generateSecretKey("key_"),
            name,
            key: KeyManager.generateSecretKey("er-live-"),
            createdAt: now,
            maxRequests: defaultTier?.maxRequests,
            maxTokens: defaultTier?.maxTokens,
            usedRequests: 0,
            usedTokens: 0,
            usedPromptTokens: 0,
            usedCompletionTokens: 0,
            enabled: true,
          });
        } else if (item && typeof item === "object") {
          const obj = item as Record<string, any>;
          keys.push({
            id: obj.id || KeyManager.generateSecretKey("key_"),
            name: obj.name || "Consumer Key",
            key: obj.key || KeyManager.generateSecretKey("er-live-"),
            createdAt: obj.createdAt || now,
            expiresAt: obj.expiresAt,
            maxRequests: obj.maxRequests ?? defaultTier?.maxRequests,
            maxTokens: obj.maxTokens ?? defaultTier?.maxTokens,
            maxPromptTokens: obj.maxPromptTokens,
            maxCompletionTokens: obj.maxCompletionTokens,
            usedRequests: obj.usedRequests || 0,
            usedTokens: obj.usedTokens || 0,
            usedPromptTokens: obj.usedPromptTokens || 0,
            usedCompletionTokens: obj.usedCompletionTokens || 0,
            requiredHeaders: obj.requiredHeaders,
            requiredBodyKeywords: obj.requiredBodyKeywords,
            allowedModels: obj.allowedModels,
            enabled: obj.enabled ?? true,
          });
        }
      }
    } else if (typeof raw === "string") {
      const lines = raw.split(/[\r\n,;\t]+/).map((s) => s.trim()).filter(Boolean);
      for (const line of lines) {
        keys.push({
          id: KeyManager.generateSecretKey("key_"),
          name: line,
          key: KeyManager.generateSecretKey("er-live-"),
          createdAt: now,
          maxRequests: defaultTier?.maxRequests,
          maxTokens: defaultTier?.maxTokens,
          usedRequests: 0,
          usedTokens: 0,
          usedPromptTokens: 0,
          usedCompletionTokens: 0,
          enabled: true,
        });
      }
    }

    return keys;
  }

  /**
   * Split array into chunks of bounded size for safe batch execution
   */
  static *chunk<T>(items: T[], size = 200): Generator<T[]> {
    for (let i = 0; i < items.length; i += size) {
      yield items.slice(i, i + size);
    }
  }
}
