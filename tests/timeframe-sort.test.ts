import { describe, expect, it } from "bun:test";
import { SqliteStorageAdapter } from "../src/storage/sqlite";
import { MemoryStorageAdapter } from "../src/storage";
import type { TelemetryLog } from "../src/types";

describe("Timeframe and Sorting Edge-Cases", () => {
  const adapters = [
    { name: "SqliteStorageAdapter", create: () => new SqliteStorageAdapter(":memory:") },
    { name: "MemoryStorageAdapter", create: () => new MemoryStorageAdapter() },
  ];

  for (const { name, create } of adapters) {
    describe(`${name}`, () => {
      const now = 1789200000000; // Fixed epoch for deterministic testing
      const hourMs = 3600 * 1000;

      const sampleLogs: TelemetryLog[] = [
        {
          id: "log-1",
          timestamp: now - 5 * hourMs,
          model: "free-fast",
          targetProvider: "local",
          targetModel: "gemini",
          status: 200,
          latencyMs: 1200,
          tokens: 500,
          promptTokens: 400,
          completionTokens: 100,
        },
        {
          id: "log-2",
          timestamp: now - 3 * hourMs,
          model: "smart-tier",
          targetProvider: "local",
          targetModel: "claude",
          status: 200,
          latencyMs: 850,
          tokens: 1500,
          promptTokens: 1000,
          completionTokens: 500,
        },
        {
          id: "log-3",
          timestamp: now - 1 * hourMs,
          model: "free-fast",
          targetProvider: "local",
          targetModel: "gemini",
          status: 429,
          latencyMs: 150,
          tokens: 0,
          promptTokens: 0,
          completionTokens: 0,
        },
        {
          id: "log-4",
          timestamp: now,
          model: "free-qwen",
          targetProvider: "local",
          targetModel: "qwen",
          status: 200,
          latencyMs: 850, // Identical latency to log-2 to test tie-breaking stability
          tokens: 2200,
          promptTokens: 1800,
          completionTokens: 400,
        },
      ];

      async function seed(storage: any) {
        for (const log of sampleLogs) {
          await storage.recordLog(log);
        }
      }

      it("handles inverted time range (since > until) gracefully with 0 results", async () => {
        const storage = create();
        await seed(storage);

        const logs = await storage.getLogs({ since: now, until: now - 5 * hourMs });
        expect(logs.length).toBe(0);

        const metrics = await storage.getMetrics({ since: now, until: now - 5 * hourMs });
        expect(metrics.totalRequests).toBe(0);
        expect(metrics.totalTokens).toBe(0);
        expect(metrics.promptTokens).toBe(0);
        expect(metrics.completionTokens).toBe(0);
      });

      it("handles exact point-in-time boundary match (since == timestamp == until)", async () => {
        const storage = create();
        await seed(storage);

        const targetTs = now - 3 * hourMs;
        const logs = await storage.getLogs({ since: targetTs, until: targetTs });
        expect(logs.length).toBe(1);
        expect(logs[0].id).toBe("log-2");

        const metrics = await storage.getMetrics({ since: targetTs, until: targetTs });
        expect(metrics.totalRequests).toBe(1);
        expect(metrics.totalTokens).toBe(1500);
      });

      it("handles half-open range with since only", async () => {
        const storage = create();
        await seed(storage);

        const logs = await storage.getLogs({ since: now - 2 * hourMs });
        expect(logs.length).toBe(2);
        expect(logs.map((l: TelemetryLog) => l.id)).toEqual(["log-4", "log-3"]);
      });

      it("handles half-open range with until only", async () => {
        const storage = create();
        await seed(storage);

        const logs = await storage.getLogs({ until: now - 2 * hourMs });
        expect(logs.length).toBe(2);
        expect(logs.map((l: TelemetryLog) => l.id)).toEqual(["log-2", "log-1"]);
      });

      it("handles future range where no logs exist", async () => {
        const storage = create();
        await seed(storage);

        const logs = await storage.getLogs({ since: now + 1000000 });
        expect(logs.length).toBe(0);

        const metrics = await storage.getMetrics({ since: now + 1000000 });
        expect(metrics.totalRequests).toBe(0);
        expect(metrics.totalTokens).toBe(0);
      });

      it("handles empty database queries safely without throwing", async () => {
        const storage = create();
        const logs = await storage.getLogs();
        expect(logs).toEqual([]);

        const metrics = await storage.getMetrics();
        expect(metrics).toEqual({
          totalRequests: 0,
          totalTokens: 0,
          promptTokens: 0,
          completionTokens: 0,
        });
      });

      it("neutralizes potential SQL injection in sortBy and order", async () => {
        const storage = create();
        await seed(storage);

        // Malicious or unknown sortBy should fallback to timestamp
        const logs = await storage.getLogs({
          sortBy: "1; DROP TABLE telemetry_logs; --" as any,
          order: "malicious_order" as any,
        });

        expect(logs.length).toBe(4);
        // Default order is DESC timestamp
        expect(logs[0].id).toBe("log-4");
        expect(logs[3].id).toBe("log-1");

        // Table still intact
        const metrics = await storage.getMetrics();
        expect(metrics.totalRequests).toBe(4);
      });

      it("sorts correctly across all supported metrics", async () => {
        const storage = create();
        await seed(storage);

        // Sort by latency asc: log-3 (150ms), log-2 & log-4 (850ms), log-1 (1200ms)
        const byLatencyAsc = await storage.getLogs({ sortBy: "latency", order: "asc" });
        expect(byLatencyAsc[0].id).toBe("log-3");
        expect(byLatencyAsc[3].id).toBe("log-1");

        // Sort by prompt_tokens desc: log-4 (1800), log-2 (1000), log-1 (400), log-3 (0)
        const byPromptDesc = await storage.getLogs({ sortBy: "prompt_tokens", order: "desc" });
        expect(byPromptDesc.map((l: TelemetryLog) => l.id)).toEqual(["log-4", "log-2", "log-1", "log-3"]);

        // Sort by completion_tokens desc: log-2 (500), log-4 (400), log-1 (100), log-3 (0)
        const byCompDesc = await storage.getLogs({ sortBy: "completion_tokens", order: "desc" });
        expect(byCompDesc.map((l: TelemetryLog) => l.id)).toEqual(["log-2", "log-4", "log-1", "log-3"]);
      });

      it("handles limit bounds correctly (limit = 0, limit = 1, limit > total)", async () => {
        const storage = create();
        await seed(storage);

        const lim0 = await storage.getLogs({ limit: 0 });
        expect(lim0.length).toBe(0);

        const lim1 = await storage.getLogs({ limit: 1 });
        expect(lim1.length).toBe(1);

        const limOver = await storage.getLogs({ limit: 1000 });
        expect(limOver.length).toBe(4);
      });
    });
  }
});
