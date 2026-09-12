import { describe, expect, it } from "bun:test";
import { BackupEngine } from "../src/core/backup";
import { MemoryStorageAdapter } from "../src/storage";

describe("Backup & Migration Engine", () => {
  it("exports configuration into standard IsoRoute JSON format", async () => {
    const storage = new MemoryStorageAdapter();
    await storage.saveProvider({
      id: "groq-main",
      name: "Groq Cloud",
      baseUrl: "https://api.groq.com/openai/v1",
      apiKey: "gsk_1,gsk_2",
      type: "openai",
      enabled: true,
    });
    await storage.saveCombo({
      id: "fast-tier",
      displayName: "Fast Tier",
      targets: [{ providerId: "groq-main", model: "llama-3.3-70b", priority: 0 }],
    });

    const backup = await BackupEngine.exportConfig(storage);
    expect(backup.version).toBe("1.0");
    expect(backup.generator).toBe("IsoRoute");
    expect(backup.providers.length).toBe(1);
    expect(backup.combos.length).toBe(1);
    expect(backup.combos[0].id).toBe("fast-tier");
  });

  it("identifies and converts 9Router backup JSON into IsoRoute models", async () => {
    const sample9R = {
      providerNodes: [
        {
          id: "custom-node-1",
          name: "TokenHarbor",
          type: "openai-compatible",
          data: JSON.stringify({ prefix: "th", baseUrl: "https://tokenharbor.ai/v1" }),
        },
      ],
      providerConnections: [
        {
          id: "conn-1",
          provider: "custom-node-1",
          authType: "apikey",
          data: JSON.stringify({ apiKey: "th-key-alpha" }),
        },
        {
          id: "conn-2",
          provider: "custom-node-1",
          authType: "apikey",
          data: JSON.stringify({ apiKey: "th-key-beta" }),
        },
        {
          id: "conn-3",
          provider: "nvidia",
          authType: "apikey",
          data: JSON.stringify({ apiKey: "nvapi-12345" }),
        },
      ],
      combos: [
        {
          id: "c-1",
          name: "deepseek-flash-latest",
          models: ["th/deepseek-v4-flash", "nvidia/deepseek-ai/deepseek-v4-flash"],
        },
      ],
    };

    expect(BackupEngine.is9RouterBackup(sample9R)).toBe(true);

    const converted = BackupEngine.convert9RouterToIsoRoute(sample9R);
    expect(converted.combos.length).toBe(1);
    expect(converted.combos[0].id).toBe("deepseek-flash-latest");
    expect(converted.combos[0].targets.length).toBe(2);
    expect(converted.combos[0].targets[0].providerId).toBe("th");

    const thProv = converted.providers.find((p) => p.id === "th");
    expect(thProv).toBeDefined();
    expect(thProv?.apiKey).toBe("th-key-alpha,th-key-beta");

    const nvProv = converted.providers.find((p) => p.id === "nvidia");
    expect(nvProv).toBeDefined();
    expect(nvProv?.apiKey).toBe("nvapi-12345");
  });

  it("imports 9Router configuration cleanly into storage", async () => {
    const storage = new MemoryStorageAdapter();
    const sample9R = {
      providerNodes: [
        {
          id: "node-amru",
          name: "AnyModel",
          data: { prefix: "amru", baseUrl: "https://anymodel.org/v1" },
        },
      ],
      providerConnections: [
        {
          id: "c1",
          provider: "amru",
          data: { apiKey: "am-key-999" },
        },
      ],
      combos: [
        {
          name: "nemotron-ultra-latest",
          models: ["amru/nemotron-3-ultra-550b"],
        },
      ],
    };

    const res = await BackupEngine.importConfig(storage, sample9R, "merge");
    expect(res.success).toBe(true);
    expect(res.format).toBe("9router");
    expect(res.stats.providersSaved).toBeGreaterThanOrEqual(1);
    expect(res.stats.combosSaved).toBe(1);

    const savedCombos = await storage.getCombos();
    expect(savedCombos.some((c) => c.id === "nemotron-ultra-latest")).toBe(true);
  });
});
