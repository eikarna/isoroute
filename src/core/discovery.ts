// Dynamic Model Discovery Engine for Upstream Providers with Smart Caching
import type { Provider } from "../types";
import { OAuthManager } from "./oauth";
import { KeyPoolManager } from "./pool";

interface CachedModels {
  models: string[];
  expiresAt: number;
}

export class ModelDiscovery {
  private static cache = new Map<string, CachedModels>();

  /**
   * Fetch active model IDs directly from upstream provider with 5-minute TTL caching
   */
  static async fetchModels(provider: Provider, forceRefresh = false): Promise<string[]> {
    const now = Date.now();
    const cached = this.cache.get(provider.id);
    if (!forceRefresh && cached && cached.expiresAt > now) {
      return cached.models;
    }

    const oauthToken = await OAuthManager.getValidAccessToken(provider);
    const token = oauthToken || KeyPoolManager.selectKey(provider);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000); // 45s timeout for heavy upstreams

    try {
      let result: string[] = [];

      if (provider.type === "gemini") {
        const url = `${provider.baseUrl.replace(/\/+$/, "")}/v1beta/models${token ? `?key=${encodeURIComponent(token)}` : ""}`;
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (token) headers["x-goog-api-key"] = token;

        const res = await fetch(url, { headers, signal: controller.signal });
        if (!res.ok) {
          throw new Error(`Gemini models API returned ${res.status}: ${await res.text()}`);
        }

        const data = await res.json() as { models?: Array<{ name: string; supportedGenerationMethods?: string[] }> };
        if (Array.isArray(data?.models)) {
          result = data.models
            .filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes("generateContent"))
            .map((m) => m.name.replace(/^models\//, ""));
        }
      } else if (provider.type === "anthropic") {
        const url = `${provider.baseUrl.replace(/\/+$/, "")}/v1/models`;
        const headers: Record<string, string> = {
          "anthropic-version": "2023-06-01",
        };
        if (token) headers["x-api-key"] = token;

        const res = await fetch(url, { headers, signal: controller.signal });
        if (!res.ok) {
          throw new Error(`Anthropic models API returned ${res.status}: ${await res.text()}`);
        }

        const data = await res.json() as { data?: Array<{ id: string }> };
        result = Array.isArray(data?.data) ? data.data.map((m) => m.id) : [];
      } else {
        // OpenAI-compatible / default
        const url = new URL("/v1/models", provider.baseUrl).toString();
        const headers: Record<string, string> = {
          ...(provider.headers || {}),
        };
        if (token) headers["Authorization"] = `Bearer ${token}`;

        const res = await fetch(url, { headers, signal: controller.signal });
        if (!res.ok) {
          throw new Error(`Upstream models API returned ${res.status}: ${await res.text()}`);
        }

        const data = await res.json() as { data?: Array<{ id: string }> };
        result = Array.isArray(data?.data) ? data.data.map((m) => m.id) : [];
      }

      clearTimeout(timeout);

      // Cache for 5 minutes
      this.cache.set(provider.id, {
        models: result,
        expiresAt: now + 300_000,
      });

      return result;
    } catch (err) {
      clearTimeout(timeout);
      console.warn(`[ModelDiscovery] Failed to fetch models for ${provider.id}:`, err);
      throw err;
    }
  }

  static clearCache(providerId?: string): void {
    if (providerId) this.cache.delete(providerId);
    else this.cache.clear();
  }
}
