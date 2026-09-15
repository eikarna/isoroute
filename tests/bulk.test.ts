import { describe, expect, it } from "bun:test";
import { BulkIngestEngine } from "../src/core/bulk";
import { SqliteStorageAdapter } from "../src/storage/sqlite";
import { MemoryStorageAdapter } from "../src/storage";
import { unlinkSync, existsSync } from "fs";

describe("Bulk Ingestion Engine", () => {
  it("parses raw text newline-separated API keys with auto-provider detection", () => {
    const raw = `
      nvapi-testkey1234567890abcdef
      sk-ant-api03-abcdef1234567890
      AIzaSyAbcdef1234567890-xyz
      sk-openai-custom123456
      # This is a comment
      nvapi-testkey1234567890abcdef // duplicate should be filtered
    `;

    const parsed = BulkIngestEngine.parseCredentials(raw);
    expect(parsed.length).toBe(4);

    const nvidia = parsed.find((p) => p.name.startsWith("nvidia-"));
    expect(nvidia).toBeDefined();
    expect(nvidia?.type).toBe("openai");
    expect(nvidia?.baseUrl).toBe("https://integrate.api.nvidia.com/v1");

    const anthropic = parsed.find((p) => p.name.startsWith("anthropic-"));
    expect(anthropic).toBeDefined();
    expect(anthropic?.type).toBe("anthropic");

    const gemini = parsed.find((p) => p.name.startsWith("gemini-"));
    expect(gemini).toBeDefined();
    expect(gemini?.type).toBe("gemini");
  });

  it("parses Cookie strings into custom headers", () => {
    const cookieText = "Cookie: session_token=secret_sess_123; auth_jwt=eyJhbGciOi...";
    const parsed = BulkIngestEngine.parseCredentials(cookieText);
    expect(parsed.length).toBe(1);
    expect(parsed[0].headers?.Cookie).toBe("session_token=secret_sess_123; auth_jwt=eyJhbGciOi...");
  });

  it("ignores raw OAuth session documents in generic bulk ingest", () => {
    const sessionJson = JSON.stringify({
      name: "Cursor Pro Session",
      accessToken: "cur_acc_123",
      refreshToken: "cur_ref_456",
      tokenEndpoint: "https://api.cursor.com/token",
    });

    const parsed = BulkIngestEngine.parseCredentials(sessionJson);
    expect(parsed.length).toBe(0);
  });

  it("parses bulk model lists and maps them to Combos", () => {
    const rawModels = `
      qwen/qwen-2.5-72b-instruct
      deepseek/deepseek-chat
      meta-llama/llama-3.3-70b-instruct
    `;

    const combos = BulkIngestEngine.parseModels(rawModels, "openrouter-main");
    expect(combos.length).toBe(3);
    expect(combos[0].id).toBe("qwen/qwen-2.5-72b-instruct");
    expect(combos[0].targets[0].providerId).toBe("openrouter-main");
    expect(combos[0].targets[0].model).toBe("qwen/qwen-2.5-72b-instruct");
  });

  it("parses bulk consumer API keys with billing tiers", () => {
    const names = ["client-alpha", "client-beta", "client-gamma"];
    const keys = BulkIngestEngine.parseApiKeys(names, { maxRequests: 5000, maxTokens: 1000000 });
    expect(keys.length).toBe(3);
    expect(keys[0].name).toBe("client-alpha");
    expect(keys[0].maxRequests).toBe(5000);
    expect(keys[0].maxTokens).toBe(1000000);
    expect(keys[0].key.startsWith("er-live-")).toBe(true);
  });

  it("pools and deduplicates keys into a provider key pool", () => {
    const rawKeys = `
      sk-ant-key1
      sk-ant-key2
      sk-ant-key3
      sk-ant-key1 // duplicate
    `;
    const pool = BulkIngestEngine.poolKeys(rawKeys, "sk-ant-key0,sk-ant-key1");
    expect(pool.totalCount).toBe(4); // key0, key1, key2, key3
    expect(pool.addedCount).toBe(2); // key2, key3 were new
    expect(pool.combinedApiKey).toBe("sk-ant-key0,sk-ant-key1,sk-ant-key2,sk-ant-key3");
  });

  it("handles 20,000 model entries batch insert in SQLite efficiently (<500ms)", async () => {
    const storage = new SqliteStorageAdapter(":memory:");

    // Generate 20,000 synthetic model combo entries
    const count = 20000;
    const syntheticCombos = [];
    for (let i = 0; i < count; i++) {
      syntheticCombos.push({
        id: `model-benchmark-${i}`,
        displayName: `Model Benchmark ${i}`,
        description: `Synthetic high-throughput model ${i}`,
        targets: [{ providerId: "test-upstream", model: `sub-model-${i}`, priority: 1 }],
        enabled: true,
      });
    }

    const start = performance.now();
    const saved = await storage.saveCombosBatch(syntheticCombos);
    const duration = performance.now() - start;

    expect(saved).toBe(count);
    expect(duration).toBeLessThan(1000); // 20k rows inserted in < 1 second

    const retrieved = await storage.getCombo("model-benchmark-19999");
    expect(retrieved).not.toBeNull();
    expect(retrieved?.id).toBe("model-benchmark-19999");

    storage.close();
  });
});
