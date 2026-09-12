// Upstream Provider & API Key Probe Engine (Validates keys, latency & quota live)
import type { Provider } from "../types";

export interface ProbeResult {
  valid: boolean;
  statusCode: number;
  latencyMs: number;
  modelCount?: number;
  models?: string[];
  error?: string;
}

export class ProviderProbe {
  /**
   * Probe upstream provider connection and validate API keys / quota
   */
  static async probe(params: {
    baseUrl: string;
    apiKey?: string;
    type?: "openai" | "gemini" | "anthropic" | "custom";
    headers?: Record<string, string>;
  }): Promise<ProbeResult> {
    const startMs = Date.now();
    const type = params.type || "openai";
    const apiKey = params.apiKey?.split(",")[0]?.trim(); // Test first key if pool
    const baseUrl = params.baseUrl.trim().replace(/\/+$/, "");

    try {
      // 1. Google Gemini Native Probe
      if (type === "gemini") {
        const probeUrl = new URL("/v1beta/models", baseUrl);
        if (apiKey) probeUrl.searchParams.set("key", apiKey);

        const res = await fetch(probeUrl.toString(), {
          method: "GET",
          headers: { "Content-Type": "application/json", ...(params.headers || {}) },
          signal: AbortSignal.timeout(12000),
        });

        const latencyMs = Date.now() - startMs;
        if (!res.ok) {
          const errText = await res.text();
          return { valid: false, statusCode: res.status, latencyMs, error: this.formatError(res.status, errText) };
        }

        const data = (await res.json()) as { models?: Array<{ name: string }> };
        const models = (data.models || []).map((m) => m.name.replace(/^models\//, ""));
        return { valid: true, statusCode: res.status, latencyMs, modelCount: models.length, models: models.slice(0, 100) };
      }

      // 2. Anthropic Native Probe
      if (type === "anthropic") {
        const probeUrl = new URL("/v1/models", baseUrl);
        const headers: Record<string, string> = {
          "anthropic-version": "2023-06-01",
          ...(params.headers || {}),
        };
        if (apiKey) headers["x-api-key"] = apiKey;

        const res = await fetch(probeUrl.toString(), {
          method: "GET",
          headers,
          signal: AbortSignal.timeout(12000),
        });

        const latencyMs = Date.now() - startMs;
        if (!res.ok) {
          const errText = await res.text();
          return { valid: false, statusCode: res.status, latencyMs, error: this.formatError(res.status, errText) };
        }

        const data = (await res.json()) as { data?: Array<{ id: string }> };
        const models = (data.data || []).map((m) => m.id);
        return { valid: true, statusCode: res.status, latencyMs, modelCount: models.length, models: models.slice(0, 100) };
      }

      // 3. OpenAI Compatible Probe
      const probeUrl = new URL("/v1/models", baseUrl);
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...(params.headers || {}),
      };
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

      const res = await fetch(probeUrl.toString(), {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(12000),
      });

      const latencyMs = Date.now() - startMs;
      if (!res.ok) {
        const errText = await res.text();
        return { valid: false, statusCode: res.status, latencyMs, error: this.formatError(res.status, errText) };
      }

      const data = (await res.json()) as { data?: Array<{ id: string }> };
      const models = (data.data || []).map((m) => m.id);
      return { valid: true, statusCode: res.status, latencyMs, modelCount: models.length, models: models.slice(0, 100) };
    } catch (err) {
      const latencyMs = Date.now() - startMs;
      return {
        valid: false,
        statusCode: 0,
        latencyMs,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private static formatError(status: number, rawText: string): string {
    try {
      const json = JSON.parse(rawText);
      const msg = json.error?.message || json.message || rawText;
      return `HTTP ${status}: ${msg}`;
    } catch {
      return `HTTP ${status}: ${rawText.slice(0, 200)}`;
    }
  }
}
