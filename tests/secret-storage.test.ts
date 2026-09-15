import { describe, expect, it } from "bun:test";
import { MemoryStorageAdapter } from "../src/storage";
import { SecretStorageAdapter } from "../src/storage/secrets";
import type { Provider } from "../src/types";

const masterKey = "test-master-key-material-with-at-least-thirty-two-chars";

function oauthProvider(): Provider {
  return {
    id: "google-adc-test",
    name: "Google ADC",
    baseUrl: "https://generativelanguage.googleapis.com",
    type: "gemini",
    enabled: true,
    oauth: {
      type: "refresh_token",
      tokenEndpoint: "https://oauth2.googleapis.com/token",
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshToken: "refresh-token",
      accessToken: "access-token",
      expiresAt: 1_700_000_000_000,
    },
  };
}

describe("SecretStorageAdapter", () => {
  it("persists OAuth material in an AES-GCM envelope and restores it only for runtime reads", async () => {
    const raw = new MemoryStorageAdapter();
    const secure = await SecretStorageAdapter.create(raw, masterKey);

    await secure.saveProvider(oauthProvider());

    const persisted = await raw.getProvider("google-adc-test");
    expect(persisted?.oauth?.sealed).toStartWith("v1.");
    expect(persisted?.oauth?.refreshToken).toBeUndefined();
    expect(persisted?.oauth?.accessToken).toBeUndefined();
    expect(persisted?.oauth?.clientSecret).toBeUndefined();

    const runtime = await secure.getProvider("google-adc-test");
    expect(runtime?.oauth).toMatchObject({
      refreshToken: "refresh-token",
      accessToken: "access-token",
      clientSecret: "client-secret",
    });
  });

  it("binds a sealed credential to its provider ID so it cannot be copied to another connection", async () => {
    const raw = new MemoryStorageAdapter();
    const secure = await SecretStorageAdapter.create(raw, masterKey);
    await secure.saveProvider(oauthProvider());

    const persisted = await raw.getProvider("google-adc-test");
    await raw.saveProvider({ ...persisted!, id: "copied-connection" });

    await expect(secure.getProvider("copied-connection")).rejects.toThrow("Unable to decrypt provider credentials");
  });
});
