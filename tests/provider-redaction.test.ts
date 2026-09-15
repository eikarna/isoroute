import { describe, expect, it } from "bun:test";
import { redactProviderSecrets } from "../src/storage/secrets";
import type { Provider } from "../src/types";

describe("provider dashboard redaction", () => {
  it("returns operational metadata but strips every provider credential", () => {
    const provider: Provider = {
      id: "provider-a",
      name: "Provider A",
      baseUrl: "https://api.example.test/v1",
      apiKey: "key-one,key-two",
      type: "openai",
      enabled: true,
      oauth: {
        type: "refresh_token",
        tokenEndpoint: "https://oauth.example.test/token",
        clientId: "public-client-id",
        clientSecret: "client-secret",
        refreshToken: "refresh-token",
        accessToken: "access-token",
        sealed: "v1.placeholder.ciphertext",
      },
    };

    const safe = redactProviderSecrets(provider);

    expect(safe.keyCount).toBe(2);
    expect(safe.apiKey).toBeUndefined();
    expect(safe.oauth).toEqual({
      type: "refresh_token",
      tokenEndpoint: "https://oauth.example.test/token",
      clientId: "public-client-id",
      expiresAt: undefined,
    });
  });
});
