import { describe, expect, it, mock } from "bun:test";
import { ModelDiscovery } from "../src/core/discovery";
import type { Provider } from "../src/types";

describe("ModelDiscovery", () => {
  it("discovers models from OpenAI-compatible provider", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      return Response.json({
        data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }],
      });
    }) as any;

    const provider: Provider = {
      id: "openai-test",
      name: "OpenAI",
      baseUrl: "https://api.openai.com",
      apiKey: "sk-test",
      type: "openai",
      enabled: true,
    };

    const models = await ModelDiscovery.fetchModels(provider);
    expect(models).toEqual(["gpt-4o", "gpt-4o-mini"]);

    globalThis.fetch = originalFetch;
  });

  it("discovers models from Gemini native provider and strips 'models/' prefix", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      return Response.json({
        models: [
          { name: "models/gemini-1.5-flash", supportedGenerationMethods: ["generateContent"] },
          { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
        ],
      });
    }) as any;

    const provider: Provider = {
      id: "gemini-test",
      name: "Gemini",
      baseUrl: "https://generativelanguage.googleapis.com",
      apiKey: "test-key",
      type: "gemini",
      enabled: true,
    };

    const models = await ModelDiscovery.fetchModels(provider);
    expect(models).toEqual(["gemini-1.5-flash"]);

    globalThis.fetch = originalFetch;
  });
});
