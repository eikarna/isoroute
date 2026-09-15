import { describe, expect, it } from "bun:test";
import { RequestSanitizer } from "../src/core/sanitizer";
import { AnthropicAdapter } from "../src/adapters/anthropic";
import { GeminiAdapter } from "../src/adapters/gemini";
import { KeyPoolManager } from "../src/core/pool";
import { SentinelEngine } from "../src/core/sentinel";
import { MemoryStorageAdapter } from "../src/storage";
import type { Provider } from "../src/types";

describe("Reasoning Budget Balancer & Self-Healing Sentinel", () => {
  const openaiProvider: Provider = {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com",
    type: "openai",
    enabled: true,
  };

  const anthropicProvider: Provider = {
    id: "anthropic",
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    type: "anthropic",
    enabled: true,
  };

  const geminiProvider: Provider = {
    id: "gemini",
    name: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com",
    type: "gemini",
    enabled: true,
  };

  it("strips reasoning parameters when sending to non-reasoning OpenAI models", () => {
    const sanitized = RequestSanitizer.sanitize(
      {
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi" }],
        // @ts-ignore
        reasoning_effort: "high",
        thinking: { type: "enabled", budget_tokens: 4000 },
      },
      openaiProvider
    );

    expect(sanitized.reasoning_effort).toBeUndefined();
    expect(sanitized.thinking).toBeUndefined();
  });

  it("preserves and normalizes reasoning parameters for reasoning models (o1, o3, etc.)", () => {
    const sanitized = RequestSanitizer.sanitize(
      {
        model: "o1-mini",
        messages: [{ role: "user", content: "solve" }],
        // @ts-ignore
        thinking: { type: "enabled", budget_tokens: 4000 },
      },
      openaiProvider
    );

    expect(sanitized.reasoning_effort).toBe("medium");
    expect(sanitized.thinking).toBeUndefined();
  });

  it("AnthropicAdapter converts reasoning_effort to thinking.budget_tokens and cleans temperature", () => {
    const payload = AnthropicAdapter.transformRequest(
      {
        model: "claude-3-7-sonnet",
        messages: [{ role: "user", content: "think" }],
        temperature: 0.7,
        // @ts-ignore
        reasoning_effort: "high",
      },
      "claude-3-7-sonnet-20250219"
    );

    expect(payload.thinking?.type).toBe("enabled");
    expect(payload.thinking?.budget_tokens).toBe(8192);
    expect(payload.max_tokens).toBeGreaterThan(8192);
    // Anthropic API rejects temperature when thinking is enabled
    expect(payload.temperature).toBeUndefined();
  });

  it("GeminiAdapter converts reasoning_effort to thinkingConfig", () => {
    const payload = GeminiAdapter.transformRequest({
      model: "gemini-3.8-flash",
      messages: [{ role: "user", content: "think" }],
      // @ts-ignore
      reasoning_effort: "low",
    });

    expect(payload.generationConfig?.thinkingConfig?.thinkingBudget).toBe(2048);
  });

  it("KeyPoolManager tracks cooldown keys and allows Sentinel to recover them", async () => {
    KeyPoolManager.reset();
    const testKey = "test-key-123456";

    KeyPoolManager.markCooldown(testKey, 60000);
    const cooldowns = KeyPoolManager.getCooldownKeys();
    expect(cooldowns).toContain(testKey);

    KeyPoolManager.clearCooldown(testKey);
    const afterClear = KeyPoolManager.getCooldownKeys();
    expect(afterClear).not.toContain(testKey);
  });

  it("SentinelEngine probes locked keys and restores them when probe succeeds", async () => {
    KeyPoolManager.reset();
    const memory = new MemoryStorageAdapter();
    const key = "key-recover-test-9999";

    await memory.saveProvider({
      id: "p-mock",
      name: "Mock Provider",
      baseUrl: "https://mock.example.com",
      apiKey: key,
      type: "openai",
      enabled: true,
    });

    KeyPoolManager.markCooldown(key, 60000);
    expect(KeyPoolManager.getCooldownKeys()).toContain(key);

    // Mock probeKey to return true
    const originalProbe = SentinelEngine.probeKey;
    SentinelEngine.probeKey = async () => true;

    const result = await SentinelEngine.runSentinel(memory);
    expect(result.checked).toBe(1);
    expect(result.recovered).toBe(1);
    expect(KeyPoolManager.getCooldownKeys()).not.toContain(key);

    // Restore
    SentinelEngine.probeKey = originalProbe;
  });
});
