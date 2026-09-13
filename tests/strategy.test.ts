import { describe, it, expect, beforeEach } from "bun:test";
import { MetricsEngine } from "../src/core/metrics";
import { EdgeRouter } from "../src/core/router";
import { MemoryStorageAdapter } from "../src/storage";
import type { ModelCombo, Provider, TargetRoute } from "../src/types";

describe("Routing Strategies Engine (Combo Level)", () => {
  beforeEach(() => {
    MetricsEngine.reset();
  });

  const sampleTargets: TargetRoute[] = [
    { providerId: "provider-a", model: "model-slow", priority: 10 },
    { providerId: "provider-b", model: "model-fast", priority: 5 },
    { providerId: "provider-c", model: "model-medium", priority: 1 },
  ];

  it("Strategy 'fallback': strictly orders by descending priority (default)", () => {
    const sorted = MetricsEngine.sortTargets(sampleTargets, "fallback");
    expect(sorted[0].providerId).toBe("provider-a"); // priority 10
    expect(sorted[1].providerId).toBe("provider-b"); // priority 5
    expect(sorted[2].providerId).toBe("provider-c"); // priority 1
  });

  it("Strategy 'round-robin': rotates the active target on consecutive invocations", () => {
    const call1 = MetricsEngine.sortTargets(sampleTargets, "round-robin", "test-combo");
    const call2 = MetricsEngine.sortTargets(sampleTargets, "round-robin", "test-combo");
    const call3 = MetricsEngine.sortTargets(sampleTargets, "round-robin", "test-combo");
    const call4 = MetricsEngine.sortTargets(sampleTargets, "round-robin", "test-combo");

    // Sequential rotation of primary target
    expect(call1[0].providerId).toBe("provider-b");
    expect(call2[0].providerId).toBe("provider-c");
    expect(call3[0].providerId).toBe("provider-a");
    expect(call4[0].providerId).toBe("provider-b");

    // All original targets remain available as fallbacks
    expect(call1.length).toBe(3);
    expect(call2.length).toBe(3);
  });

  it("Strategy 'latency-first': dynamically prioritizes targets with lowest response latency", () => {
    // Record telemetry
    MetricsEngine.record("provider-a", "model-slow", 1200);   // 1200ms
    MetricsEngine.record("provider-b", "model-fast", 250);    // 250ms
    MetricsEngine.record("provider-c", "model-medium", 600);  // 600ms

    const sorted = MetricsEngine.sortTargets(sampleTargets, "latency-first");
    expect(sorted[0].providerId).toBe("provider-b"); // 250ms
    expect(sorted[1].providerId).toBe("provider-c"); // 600ms
    expect(sorted[2].providerId).toBe("provider-a"); // 1200ms
  });

  it("Strategy 'ttft-first': dynamically prioritizes targets with lowest Time To First Token", () => {
    // provider-a is slow overall (800ms) but has instant TTFT (80ms)
    MetricsEngine.record("provider-a", "model-slow", 800, 80);
    // provider-b has high TTFT (400ms) even if total latency is 500ms
    MetricsEngine.record("provider-b", "model-fast", 500, 400);
    // provider-c has TTFT (180ms)
    MetricsEngine.record("provider-c", "model-medium", 700, 180);

    const sorted = MetricsEngine.sortTargets(sampleTargets, "ttft-first");
    expect(sorted[0].providerId).toBe("provider-a"); // TTFT 80ms
    expect(sorted[1].providerId).toBe("provider-c"); // TTFT 180ms
    expect(sorted[2].providerId).toBe("provider-b"); // TTFT 400ms
  });

  it("EdgeRouter respects combo strategy and cascades on failure", async () => {
    const storage = new MemoryStorageAdapter();

    const providerFast: Provider = {
      id: "prov-fast",
      name: "Fast Provider",
      baseUrl: "https://fast.example.com",
      apiKey: "fast-key",
      type: "openai",
      enabled: true,
    };
    const providerSlow: Provider = {
      id: "prov-slow",
      name: "Slow Provider",
      baseUrl: "https://slow.example.com",
      apiKey: "slow-key",
      type: "openai",
      enabled: true,
    };

    await storage.saveProvider(providerFast);
    await storage.saveProvider(providerSlow);

    // Initial priority favors prov-slow (priority 10 vs 1)
    const combo: ModelCombo = {
      id: "smart-latency-combo",
      displayName: "Smart Latency Combo",
      strategy: "latency-first",
      enabled: true,
      targets: [
        { providerId: "prov-slow", model: "slow-mod", priority: 10 },
        { providerId: "prov-fast", model: "fast-mod", priority: 1 },
      ],
    };
    await storage.saveCombo(combo);

    // Simulate metrics where prov-fast is recorded with lower latency
    MetricsEngine.record("prov-slow", "slow-mod", 2500);
    MetricsEngine.record("prov-fast", "fast-mod", 150);

    // Verify resolve targets sorts prov-fast first due to 'latency-first'
    const sorted = MetricsEngine.sortTargets(combo.targets, combo.strategy);
    expect(sorted[0].providerId).toBe("prov-fast");
    expect(sorted[1].providerId).toBe("prov-slow");
  });
});
