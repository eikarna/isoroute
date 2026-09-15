import { describe, expect, it } from "bun:test";
import { BUILTIN_OAUTH_PROVIDER_CATALOG, OAuthManager } from "../src/core/oauth";

describe("OAuth provider catalog", () => {
  const googleAdc = JSON.stringify({
    type: "authorized_user",
    client_id: "client-id.apps.googleusercontent.com",
    client_secret: "client-secret",
    refresh_token: "refresh-token",
    token_uri: "https://oauth2.googleapis.com/token",
  });

  it("lists built-in connections independently from manually registered providers", () => {
    const google = BUILTIN_OAUTH_PROVIDER_CATALOG.find((definition) => definition.id === "google-adc");
    const cursor = BUILTIN_OAUTH_PROVIDER_CATALOG.find((definition) => definition.id === "cursor-official-api");

    expect(google?.connectionMode).toBe("session_import");
    expect(google?.transport).toBe("gemini-native");
    expect(cursor?.connectionMode).toBe("api_key");
    expect(cursor?.available).toBe(false);
  });

  it("creates a Gemini-native connection from Google ADC without retaining raw session JSON", () => {
    const connection = OAuthManager.createBuiltinConnection({
      catalogId: "google-adc",
      label: "Workspace ADC",
      sessionJson: googleAdc,
      idFactory: () => "google-adc-test",
    });

    expect(connection).toMatchObject({
      id: "google-adc-test",
      name: "Workspace ADC",
      baseUrl: "https://generativelanguage.googleapis.com",
      type: "gemini",
      enabled: true,
      oauth: {
        type: "refresh_token",
        tokenEndpoint: "https://oauth2.googleapis.com/token",
        clientId: "client-id.apps.googleusercontent.com",
        refreshToken: "refresh-token",
      },
    });
    expect(connection.oauth).not.toHaveProperty("rawSessionJson");
  });

  it("rejects a session import for catalog entries with no supported import driver", () => {
    expect(() => OAuthManager.createBuiltinConnection({
      catalogId: "cursor-official-api",
      label: "Cursor",
      sessionJson: googleAdc,
      idFactory: () => "cursor-test",
    })).toThrow("does not support session import");
  });

  it("rejects Google ADC JSON with an untrusted token endpoint", () => {
    const untrusted = JSON.stringify({
      type: "authorized_user",
      client_id: "client-id",
      client_secret: "client-secret",
      refresh_token: "refresh-token",
      token_uri: "https://attacker.example/token",
    });

    expect(() => OAuthManager.createBuiltinConnection({
      catalogId: "google-adc",
      label: "Workspace ADC",
      sessionJson: untrusted,
      idFactory: () => "google-adc-test",
    })).toThrow("Google ADC token endpoint");
  });
});


describe("OAuth session parsing", () => {
  it("does not preserve raw imported session documents", () => {
    const parsed = OAuthManager.parseSessionJson(JSON.stringify({ access_token: "token" }));
    expect(parsed).not.toHaveProperty("rawSessionJson");
  });
});
