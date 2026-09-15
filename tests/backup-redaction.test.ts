import { describe, expect, it } from "bun:test";
import { BackupEngine } from "../src/core/backup";
import { MemoryStorageAdapter } from "../src/storage";

describe("configuration export redaction", () => {
  it("never includes provider API keys or OAuth credentials", async () => {
    const storage = new MemoryStorageAdapter();
    await storage.saveProvider({
      id: "private-upstream",
      name: "Private Upstream",
      baseUrl: "https://api.example.test/v1",
      apiKey: "provider-api-key",
      type: "openai",
      enabled: true,
      oauth: {
        type: "refresh_token",
        clientId: "client-id",
        clientSecret: "client-secret",
        refreshToken: "refresh-token",
        accessToken: "access-token",
      },
    });

    const exported = await BackupEngine.exportConfig(storage);
    const serialized = JSON.stringify(exported);

    expect(serialized).not.toContain("provider-api-key");
    expect(serialized).not.toContain("client-secret");
    expect(serialized).not.toContain("refresh-token");
    expect(serialized).not.toContain("access-token");
    expect(exported.providers[0].oauth?.clientId).toBe("client-id");
  });
});
