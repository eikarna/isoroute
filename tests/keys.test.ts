import { describe, expect, it } from "bun:test";
import { KeyManager, type ApiKeyRecord } from "../src/core/keys";
import type { ChatCompletionRequest } from "../src/types";

describe("KeyManager Billing & Guard Policies", () => {
  const baseKey: ApiKeyRecord = {
    id: "key-test-1",
    name: "Test Client",
    key: "er-live-secret123",
    createdAt: Date.now(),
    usedRequests: 0,
    usedTokens: 0,
    usedPromptTokens: 0,
    usedCompletionTokens: 0,
    enabled: true,
  };

  const dummyReq = new Request("http://localhost:20129/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });

  const dummyBody: ChatCompletionRequest = {
    model: "claude-3-5-sonnet",
    messages: [{ role: "user", content: "hello" }],
  };

  it("passes validation for healthy key without quotas", () => {
    const res = KeyManager.validate(dummyReq, dummyBody, { ...baseKey });
    expect(res.valid).toBe(true);
  });

  it("blocks disabled key with 403", () => {
    const res = KeyManager.validate(dummyReq, dummyBody, { ...baseKey, enabled: false });
    expect(res.valid).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.error).toContain("disabled");
  });

  it("blocks expired key with 403", () => {
    const res = KeyManager.validate(dummyReq, dummyBody, { ...baseKey, expiresAt: Date.now() - 1000 });
    expect(res.valid).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.error).toContain("expired");
  });

  it("blocks key when maxRequests is reached with 429", () => {
    const res = KeyManager.validate(dummyReq, dummyBody, { ...baseKey, maxRequests: 5, usedRequests: 5 });
    expect(res.valid).toBe(false);
    expect(res.statusCode).toBe(429);
    expect(res.error).toContain("request quota");
  });

  it("blocks key when maxTokens is reached with 429", () => {
    const res = KeyManager.validate(dummyReq, dummyBody, { ...baseKey, maxTokens: 1000, usedTokens: 1000 });
    expect(res.valid).toBe(false);
    expect(res.statusCode).toBe(429);
    expect(res.error).toContain("total token quota");
  });

  it("blocks key when maxPromptTokens is reached with 429", () => {
    const res = KeyManager.validate(dummyReq, dummyBody, { ...baseKey, maxPromptTokens: 500, usedPromptTokens: 500 });
    expect(res.valid).toBe(false);
    expect(res.statusCode).toBe(429);
    expect(res.error).toContain("prompt token quota");
  });

  it("blocks key when maxCompletionTokens is reached with 429", () => {
    const res = KeyManager.validate(dummyReq, dummyBody, { ...baseKey, maxCompletionTokens: 200, usedCompletionTokens: 200 });
    expect(res.valid).toBe(false);
    expect(res.statusCode).toBe(429);
    expect(res.error).toContain("completion token quota");
  });

  it("enforces requiredHeaders guard", () => {
    const guardedKey: ApiKeyRecord = {
      ...baseKey,
      requiredHeaders: { "x-partner-id": "app-alpha" },
    };

    // Missing header
    const failRes = KeyManager.validate(dummyReq, dummyBody, guardedKey);
    expect(failRes.valid).toBe(false);
    expect(failRes.statusCode).toBe(403);
    expect(failRes.error).toContain("Missing required header: 'x-partner-id'");

    // Present matching header
    const validReq = new Request("http://localhost:20129/v1/chat/completions", {
      method: "POST",
      headers: { "x-partner-id": "app-alpha" },
    });
    const passRes = KeyManager.validate(validReq, dummyBody, guardedKey);
    expect(passRes.valid).toBe(true);
  });

  it("enforces requiredBodyKeywords guard", () => {
    const guardedKey: ApiKeyRecord = {
      ...baseKey,
      requiredBodyKeywords: ["authorized_tag_2026"],
    };

    const failRes = KeyManager.validate(dummyReq, dummyBody, guardedKey);
    expect(failRes.valid).toBe(false);
    expect(failRes.statusCode).toBe(403);
    expect(failRes.error).toContain("security signature");

    const passRes = KeyManager.validate(dummyReq, { ...dummyBody, custom_tag: "authorized_tag_2026" }, guardedKey);
    expect(passRes.valid).toBe(true);
  });

  it("enforces allowedModels wildcard whitelist", () => {
    const guardedKey: ApiKeyRecord = {
      ...baseKey,
      allowedModels: ["free-*", "gemini-*"],
    };

    // Disallowed model
    const failRes = KeyManager.validate(dummyReq, { ...dummyBody, model: "gpt-4o" }, guardedKey);
    expect(failRes.valid).toBe(false);
    expect(failRes.statusCode).toBe(403);
    expect(failRes.error).toContain("not authorized");

    // Allowed model
    const passRes = KeyManager.validate(dummyReq, { ...dummyBody, model: "gemini-3-flash" }, guardedKey);
    expect(passRes.valid).toBe(true);
  });

  it("updates consumer key and resets used tokens/requests in storage", async () => {
    const { SqliteStorageAdapter } = await import("../src/storage/sqlite");
    const storage = new SqliteStorageAdapter(":memory:");
    await storage.init();

    const initialKey: ApiKeyRecord = {
      ...baseKey,
      id: "test_update_key",
      key: "er-test-update-12345",
      usedRequests: 50,
      usedTokens: 100000,
      maxRequests: 100,
      maxTokens: 500000,
      allowedModels: ["kimi-latest"],
    };
    await storage.saveKey(initialKey);

    const saved = await storage.getKey("test_update_key");
    expect(saved?.usedRequests).toBe(50);
    expect(saved?.usedTokens).toBe(100000);
    expect(saved?.allowedModels).toEqual(["kimi-latest"]);

    // Update key: reset used tokens and requests, update allowed models and quotas
    const updatedKey: ApiKeyRecord = {
      ...saved!,
      name: "VIP Key Updated",
      usedRequests: 0,
      usedTokens: 0,
      maxTokens: 2000000,
      allowedModels: ["kimi-latest", "gemini-flash-latest"],
      expiresAt: Date.now() + 86400000,
    };
    await storage.saveKey(updatedKey);

    const retrieved = await storage.getKey("test_update_key");
    expect(retrieved?.name).toBe("VIP Key Updated");
    expect(retrieved?.usedRequests).toBe(0);
    expect(retrieved?.usedTokens).toBe(0);
    expect(retrieved?.maxTokens).toBe(2000000);
    expect(retrieved?.allowedModels).toEqual(["kimi-latest", "gemini-flash-latest"]);
    expect(retrieved?.expiresAt).toBeGreaterThan(Date.now());
  });
});
