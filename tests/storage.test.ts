import { describe, expect, it } from "bun:test";
import { SqliteStorageAdapter } from "../src/storage/sqlite";
import type { ModelCombo, Provider, TelemetryLog } from "../src/types";

describe("SqliteStorageAdapter", () => {
  it("persists and retrieves providers across instances with file database", async () => {
    const dbName = `test-persist-${Date.now()}.db`;
    const storage = new SqliteStorageAdapter(dbName);

    const p: Provider = {
      id: "prov-1",
      name: "Provider One",
      baseUrl: "https://api.one.com",
      apiKey: "sk-test",
      type: "gemini",
      enabled: true,
      oauth: { type: "refresh_token", refreshToken: "ref-123" },
    };

    await storage.saveProvider(p);
    const retrieved = await storage.getProvider("prov-1");

    expect(retrieved).not.toBeNull();
    expect(retrieved?.id).toBe("prov-1");
    expect(retrieved?.type).toBe("gemini");
    expect(retrieved?.oauth?.refreshToken).toBe("ref-123");

    // Close and re-open to test durability
    storage.close();
    const secondStorage = new SqliteStorageAdapter(dbName);
    const persisted = await secondStorage.getProvider("prov-1");
    expect(persisted?.name).toBe("Provider One");
    secondStorage.close();
  });

  it("persists and manages combos and cascades", async () => {
    const storage = new SqliteStorageAdapter(":memory:");
    const combo: ModelCombo = {
      id: "super-fast",
      displayName: "Super Fast Tier",
      description: "Fallback ladder",
      enabled: true,
      targets: [
        { providerId: "prov-1", model: "model-a", priority: 10 },
        { providerId: "prov-2", model: "model-b", priority: 5 },
      ],
    };

    await storage.saveCombo(combo);
    const retrieved = await storage.getCombo("super-fast");

    expect(retrieved?.displayName).toBe("Super Fast Tier");
    expect(retrieved?.targets.length).toBe(2);
    expect(retrieved?.targets[0].priority).toBe(10);

    // Delete
    await storage.deleteCombo("super-fast");
    const deleted = await storage.getCombo("super-fast");
    expect(deleted).toBeNull();
    storage.close();
  });

  it("records logs and aggregates total tokens & metrics", async () => {
    const storage = new SqliteStorageAdapter(":memory:");
    const log: TelemetryLog = {
      id: "log-1",
      timestamp: Date.now(),
      model: "free-qwen",
      targetProvider: "prov-1",
      targetModel: "qwen-32b",
      status: 200,
      latencyMs: 450,
      tokens: 1500,
      promptTokens: 1200,
      completionTokens: 300,
    };

    await storage.recordLog(log);
    const logs = await storage.getLogs();
    const metrics = await storage.getMetrics();

    expect(logs.length).toBe(1);
    expect(logs[0].tokens).toBe(1500);
    expect(logs[0].promptTokens).toBe(1200);
    expect(logs[0].completionTokens).toBe(300);
    expect(metrics.totalRequests).toBe(1);
    expect(metrics.totalTokens).toBe(1500);
    expect(metrics.promptTokens).toBe(1200);
    expect(metrics.completionTokens).toBe(300);

    await storage.clearLogs();
    const afterClear = await storage.getMetrics();
    expect(afterClear.totalRequests).toBe(0);
    expect(afterClear.totalTokens).toBe(0);
    expect(afterClear.promptTokens).toBe(0);
    expect(afterClear.completionTokens).toBe(0);
    storage.close();
  });

  it("filters logs by time range and sorts by any numeric column", async () => {
    const storage = new SqliteStorageAdapter(":memory:");
    const now = Date.now();
    const dayMs = 86400 * 1000;

    const base = {
      model: "combo",
      targetProvider: "prov",
      targetModel: "m",
      status: 200,
    };

    await storage.recordLog({ ...base, id: "old", timestamp: now - 10 * dayMs, latencyMs: 900, tokens: 10, promptTokens: 8, completionTokens: 2 });
    await storage.recordLog({ ...base, id: "mid", timestamp: now - 3 * dayMs, latencyMs: 100, tokens: 500, promptTokens: 400, completionTokens: 100 });
    await storage.recordLog({ ...base, id: "new", timestamp: now - 1000, latencyMs: 400, tokens: 50, promptTokens: 20, completionTokens: 30 });

    // 7-day window must exclude the 10-day-old record
    const week = await storage.getLogs({ since: now - 7 * dayMs, limit: 100 });
    expect(week.length).toBe(2);
    expect(week.map((l) => l.id).sort()).toEqual(["mid", "new"]);

    const weekMetrics = await storage.getMetrics({ since: now - 7 * dayMs });
    expect(weekMetrics.totalRequests).toBe(2);
    expect(weekMetrics.totalTokens).toBe(550);
    expect(weekMetrics.promptTokens).toBe(420);
    expect(weekMetrics.completionTokens).toBe(130);

    // Ascending sort by latency
    const byLatency = await storage.getLogs({ limit: 100, sortBy: "latency", order: "asc" });
    expect(byLatency.map((l) => l.id)).toEqual(["mid", "new", "old"]);

    // Descending sort by output tokens
    const byOutput = await storage.getLogs({ limit: 100, sortBy: "completion_tokens", order: "desc" });
    expect(byOutput.map((l) => l.id)).toEqual(["mid", "new", "old"]);

    // Custom explicit until bound (only the oldest record)
    const bounded = await storage.getLogs({ since: now - 11 * dayMs, until: now - 9 * dayMs, limit: 100 });
    expect(bounded.map((l) => l.id)).toEqual(["old"]);

    storage.close();
  });
});
