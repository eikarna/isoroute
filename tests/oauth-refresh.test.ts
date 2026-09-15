import { describe, expect, it } from "bun:test";
import { OAuthManager } from "../src/core/oauth";
import type { Provider } from "../src/types";

describe("OAuth refresh persistence", () => {
  it("persists a rotated access credential after a successful refresh", async () => {
    const originalFetch = globalThis.fetch;
    const provider: Provider = {
      id: "google-adc-workspace",
      name: "Workspace ADC",
      baseUrl: "https://generativelanguage.googleapis.com",
      type: "gemini",
      enabled: true,
      oauth: {
        type: "refresh_token",
        tokenEndpoint: "https://oauth2.googleapis.com/token",
        clientId: "client-id",
        clientSecret: "client-secret",
        refreshToken: "old-refresh-token",
        expiresAt: 0,
      },
    };
    let persisted: Provider | undefined;

    globalThis.fetch = async () => Response.json({
      access_token: "new-access-token",
      refresh_token: "new-refresh-token",
      expires_in: 3600,
    });

    try {
      const token = await OAuthManager.getValidAccessToken(provider, async (updated) => {
        persisted = structuredClone(updated);
      });

      expect(token).toBe("new-access-token");
      expect(persisted?.oauth).toMatchObject({
        accessToken: "new-access-token",
        refreshToken: "new-refresh-token",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
