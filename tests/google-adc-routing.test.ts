import { describe, expect, it, mock } from "bun:test";
import { EdgeRouter } from "../src/core/router";
import { MemoryStorageAdapter } from "../src/storage";
import type { ChatCompletionRequest, ModelCombo, Provider } from "../src/types";

describe("Google ADC routing", () => {
  it("sends an ADC access token as OAuth Bearer authentication, never as an API key", async () => {
    const originalFetch = globalThis.fetch;
    let requestHeaders: Headers | undefined;

    globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      requestHeaders = new Headers(init?.headers);
      return Response.json({
        candidates: [{ content: { parts: [{ text: "Connected" }], role: "model" }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 },
      });
    }) as typeof fetch;

    const provider: Provider = {
      id: "adc-workspace",
      name: "ADC Workspace",
      baseUrl: "https://generativelanguage.googleapis.com",
      type: "gemini",
      enabled: true,
      connection: {
        catalogId: "google-adc",
        transport: "gemini-native",
        status: "active",
        createdAt: Date.now(),
      },
      oauth: {
        type: "refresh_token",
        accessToken: "adc-access-token",
        expiresAt: Date.now() + 3_600_000,
      },
    };
    const combo: ModelCombo = {
      id: "gemini-adc",
      displayName: "Gemini ADC",
      enabled: true,
      targets: [{ providerId: provider.id, model: "gemini-2.5-flash", priority: 1 }],
    };

    try {
      const router = new EdgeRouter(new MemoryStorageAdapter({ providers: [provider], combos: [combo] }));
      const request = new Request("https://isoroute.test/v1/chat/completions", { method: "POST" });
      const body: ChatCompletionRequest = {
        model: combo.id,
        messages: [{ role: "user", content: "Ping" }],
      };

      const response = await router.dispatch(request, body);
      expect(response.status).toBe(200);
      expect(requestHeaders?.get("authorization")).toBe("Bearer adc-access-token");
      expect(requestHeaders?.get("x-goog-api-key")).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
