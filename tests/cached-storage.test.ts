import { describe, expect, it } from "bun:test";
import { CachedStorageAdapter } from "../src/storage/cached";
import { MemoryStorageAdapter } from "../src/storage";
import { EdgeRouter } from "../src/core/router";
import type { ModelCombo, Provider } from "../src/types";

describe("CachedStorageAdapter & Smart Aliasing", () => {
  it("serves reads from in-memory cache and falls back to underlying DB on miss", async () => {
    let dbReads = 0;
    const memory = new MemoryStorageAdapter();

    // Wrap memory adapter to count calls
    const originalGetProvider = memory.getProvider.bind(memory);
    memory.getProvider = async (id: string) => {
      dbReads++;
      return originalGetProvider(id);
    };

    await memory.saveProvider({
      id: "p1",
      name: "Provider 1",
      baseUrl: "https://api.p1.com",
      type: "openai",
      enabled: true,
    });

    const cached = new CachedStorageAdapter(memory, 60000);

    // First call: cache miss, queries DB
    const res1 = await cached.getProvider("p1");
    expect(res1?.id).toBe("p1");
    expect(dbReads).toBe(1);

    // Second call: cache hit from RAM, 0 DB queries!
    const res2 = await cached.getProvider("p1");
    expect(res2?.id).toBe("p1");
    expect(dbReads).toBe(1);

    // Query non-existent: miss on RAM, checks DB, returns null
    const resMiss = await cached.getProvider("unknown-p");
    expect(resMiss).toBeNull();
    expect(dbReads).toBe(2);
  });

  it("invalidates cache immediately on save or delete mutations", async () => {
    const memory = new MemoryStorageAdapter();
    const cached = new CachedStorageAdapter(memory, 60000);

    await cached.saveCombo({
      id: "combo-1",
      displayName: "Combo 1",
      targets: [{ providerId: "p1", model: "m1", priority: 1 }],
      enabled: true,
    });

    const c1 = await cached.getCombo("combo-1");
    expect(c1?.displayName).toBe("Combo 1");

    // Mutation
    await cached.saveCombo({
      id: "combo-1",
      displayName: "Combo 1 Updated",
      targets: [{ providerId: "p1", model: "m1", priority: 1 }],
      enabled: true,
    });

    // Invalidation ensures updated version is returned immediately
    const c2 = await cached.getCombo("combo-1");
    expect(c2?.displayName).toBe("Combo 1 Updated");
  });

  it("fuzzy aliases unknown agent model names to active relevant combos without 404", async () => {
    const memory = new MemoryStorageAdapter();
    await memory.saveProvider({
      id: "mock-gemini",
      name: "Mock Gemini",
      baseUrl: "https://mock.gemini.com",
      type: "openai",
      enabled: true,
    });
    await memory.saveCombo({
      id: "gemini-flash-latest",
      displayName: "Gemini Flash Latest",
      targets: [{ providerId: "mock-gemini", model: "gemini-3.8-flash", priority: 10 }],
      enabled: true,
    });
    await memory.saveCombo({
      id: "smart-tier",
      displayName: "Smart Tier",
      targets: [{ providerId: "mock-gemini", model: "claude-3-7-sonnet", priority: 10 }],
      enabled: true,
    });

    const cached = new CachedStorageAdapter(memory, 60000);
    const router = new EdgeRouter(cached);

    // Call resolveTargets via dispatch with unknown model "claude-3-5-sonnet-20241022"
    // Since mock server isn't running, it should resolve targets to smart-tier and attempt fetch (504/network) instead of 404
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

    const resClaude = await router.dispatch(req, {
      model: "claude-3-5-sonnet-20241022",
      messages: [{ role: "user", content: "hi" }],
    });

    // It should NOT be 404 Model Not Found! It found the target and attempted routing!
    expect(resClaude.status).not.toBe(404);

    const resGemini = await router.dispatch(req, {
      model: "gemini-2.0-flash-exp",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(resGemini.status).not.toBe(404);
  });
});
