import { describe, it, expect, beforeEach } from "bun:test";
import { KeyPoolManager } from "../src/core/pool";
import type { Provider } from "../src/types";

describe("KeyPoolManager Provider Key Strategy & Sticky Routing", () => {
  beforeEach(() => {
    KeyPoolManager.reset();
  });

  it("Strategy 'fallback' (default): always uses the primary healthy key unless cooldown trips", () => {
    const provider: Provider = {
      id: "prov-fb",
      name: "Fallback Provider",
      baseUrl: "https://api.example.com",
      apiKey: "key-1, key-2, key-3",
      type: "openai",
      enabled: true,
      keyStrategy: "fallback",
    };

    // Subsequent requests always return key-1
    expect(KeyPoolManager.selectKey(provider)).toBe("key-1");
    expect(KeyPoolManager.selectKey(provider)).toBe("key-1");
    expect(KeyPoolManager.selectKey(provider)).toBe("key-1");

    // Key-1 trips circuit breaker (e.g. 429 or 401)
    KeyPoolManager.markCooldown("key-1", 60000);

    // Cascades to key-2 immediately
    expect(KeyPoolManager.selectKey(provider)).toBe("key-2");
    expect(KeyPoolManager.selectKey(provider)).toBe("key-2");

    // Key-2 also trips
    KeyPoolManager.markCooldown("key-2", 60000);
    expect(KeyPoolManager.selectKey(provider)).toBe("key-3");
  });

  it("Strategy 'round-robin' with stickyCount=1: rotates keys on every request", () => {
    const provider: Provider = {
      id: "prov-rr",
      name: "Round Robin Provider",
      baseUrl: "https://api.example.com",
      apiKey: "key-A, key-B, key-C",
      type: "openai",
      enabled: true,
      keyStrategy: "round-robin",
      stickyCount: 1,
    };

    expect(KeyPoolManager.selectKey(provider)).toBe("key-A");
    expect(KeyPoolManager.selectKey(provider)).toBe("key-B");
    expect(KeyPoolManager.selectKey(provider)).toBe("key-C");
    expect(KeyPoolManager.selectKey(provider)).toBe("key-A");
  });

  it("Strategy 'round-robin' with stickyCount=3: sticks to same key for 3 requests before rotating", () => {
    const provider: Provider = {
      id: "prov-sticky",
      name: "Sticky Provider",
      baseUrl: "https://api.example.com",
      apiKey: "key-X, key-Y",
      type: "openai",
      enabled: true,
      keyStrategy: "round-robin",
      stickyCount: 3,
    };

    // 3 requests to key-X
    expect(KeyPoolManager.selectKey(provider)).toBe("key-X");
    expect(KeyPoolManager.selectKey(provider)).toBe("key-X");
    expect(KeyPoolManager.selectKey(provider)).toBe("key-X");

    // Next 3 requests to key-Y
    expect(KeyPoolManager.selectKey(provider)).toBe("key-Y");
    expect(KeyPoolManager.selectKey(provider)).toBe("key-Y");
    expect(KeyPoolManager.selectKey(provider)).toBe("key-Y");

    // Rotates back to key-X
    expect(KeyPoolManager.selectKey(provider)).toBe("key-X");
  });

  it("Bypasses key in cooldown during round-robin immediately", () => {
    const provider: Provider = {
      id: "prov-rr-cooldown",
      name: "RR Cooldown",
      baseUrl: "https://api.example.com",
      apiKey: "key-1, key-2, key-3",
      type: "openai",
      enabled: true,
      keyStrategy: "round-robin",
      stickyCount: 5,
    };

    expect(KeyPoolManager.selectKey(provider)).toBe("key-1");
    // key-1 fails
    KeyPoolManager.markCooldown("key-1", 60000);

    // Immediately rotates to healthy key
    const next = KeyPoolManager.selectKey(provider);
    expect(["key-2", "key-3"]).toContain(next!);
  });
});
