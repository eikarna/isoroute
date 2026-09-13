import { describe, expect, it, mock } from "bun:test";
import { EdgeRouter } from "../src/core/router";
import { MemoryStorageAdapter } from "../src/storage";
import type { ChatCompletionRequest, ModelCombo, Provider } from "../src/types";
import type { ApiKeyRecord } from "../src/core/keys";

describe("Security Model Isolation & Consumer Key Sandbox", () => {
  const providers: Provider[] = [
    { id: "vlee", name: "VLEE", baseUrl: "https://api.vleee.net/v1", type: "openai", enabled: true },
    { id: "secret-corp", name: "Secret", baseUrl: "https://secret.corp/v1", type: "openai", enabled: true },
  ];

  const combos: ModelCombo[] = [
    {
      id: "kimi-latest",
      displayName: "Kimi Latest",
      enabled: true,
      targets: [{ providerId: "vlee", model: "cb/kimi-k3", priority: 1 }],
    },
    {
      id: "secret-vip-combo",
      displayName: "Secret VIP Combo",
      enabled: true,
      targets: [{ providerId: "secret-corp", model: "vip-model", priority: 1 }],
    },
  ];

  const apiKeys: ApiKeyRecord[] = [
    {
      id: "key-restricted",
      name: "Restricted Client",
      key: "er-live-restricted-key-12345",
      createdAt: Date.now(),
      allowedModels: ["kimi-latest"],
      enabled: true,
      usedRequests: 0,
      usedTokens: 0,
      usedPromptTokens: 0,
      usedCompletionTokens: 0,
    },
  ];

  it("blocks unauthenticated or invalid key when consumer keys exist", async () => {
    const storage = new MemoryStorageAdapter({ providers, combos, apiKeys });
    const router = new EdgeRouter(storage);

    // No auth header
    const req1 = new Request("http://localhost/v1/chat/completions", { method: "POST" });
    const res1 = await router.dispatch(req1, { model: "kimi-latest", messages: [] });
    expect(res1.status).toBe(401);

    // Fake key
    const req2 = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer sk-fake-key" },
    });
    const res2 = await router.dispatch(req2, { model: "kimi-latest", messages: [] });
    expect(res2.status).toBe(401);
  });

  it("blocks access to unauthorized combos (403)", async () => {
    const storage = new MemoryStorageAdapter({ providers, combos, apiKeys });
    const router = new EdgeRouter(storage);

    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer er-live-restricted-key-12345" },
    });

    // Trying to call secret-vip-combo
    const res = await router.dispatch(req, { model: "secret-vip-combo", messages: [] });
    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.error.message).toContain("not authorized");
  });

  it("blocks direct provider routing bypass attempt (403)", async () => {
    const storage = new MemoryStorageAdapter({ providers, combos, apiKeys });
    const router = new EdgeRouter(storage);

    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer er-live-restricted-key-12345" },
    });

    // Trying to bypass via direct provider route
    const res = await router.dispatch(req, { model: "secret-corp/vip-model", messages: [] });
    expect(res.status).toBe(403);
  });

  it("blocks rewrite rule spoofing when target model after rewrite is forbidden (403)", async () => {
    const storage = new MemoryStorageAdapter({
      providers,
      combos,
      apiKeys,
      rules: [
        {
          id: "rule-1",
          pattern: "kimi-latest",
          target: "secret-vip-combo",
          priority: 10,
          enabled: true,
        },
      ],
    });
    const router = new EdgeRouter(storage);

    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer er-live-restricted-key-12345" },
    });

    // User asks for kimi-latest, but rule rewrites to secret-vip-combo
    const res = await router.dispatch(req, { model: "kimi-latest", messages: [] });
    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.error.message).toContain("not authorized for this API key");
  });

  it("filters /v1/models strictly to only allowed models for the consumer key", async () => {
    const storage = new MemoryStorageAdapter({ providers, combos, apiKeys });
    
    // Simulate what /v1/models does
    const keyRecord = await storage.getKey("er-live-restricted-key-12345");
    let visibleCombos = await storage.getCombos();
    
    if (keyRecord?.allowedModels && keyRecord.allowedModels.length > 0) {
      visibleCombos = visibleCombos.filter((c) => {
        return keyRecord.allowedModels!.some((p) => p.trim() === c.id);
      });
    }

    expect(visibleCombos.length).toBe(1);
    expect(visibleCombos[0].id).toBe("kimi-latest");
    expect(visibleCombos.some((c) => c.id === "secret-vip-combo")).toBe(false);
  });
});
