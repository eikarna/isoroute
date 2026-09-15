// Built-in connection catalog and standard OAuth 2.0 token management.
// Provider-specific transports are explicit: a session credential never makes an
// arbitrary upstream OpenAI-compatible.
import type { Provider, ProviderOAuth } from "../types";

export type BuiltinConnectionMode = "session_import" | "native_bridge" | "api_key";
export type BuiltinProviderTransport = "gemini-native" | "native-bridge" | "cursor-official" | "generic-oauth";

export interface BuiltinOAuthProviderDefinition {
  id: string;
  name: string;
  description: string;
  transport: BuiltinProviderTransport;
  connectionMode: BuiltinConnectionMode;
  available: boolean;
  availabilityNote?: string;
  providerType: Provider["type"];
  baseUrl: string;
  documentationUrl: string;
}

export const BUILTIN_OAUTH_PROVIDER_CATALOG: readonly BuiltinOAuthProviderDefinition[] = [
  {
    id: "google-adc",
    name: "Google ADC / Gemini CLI",
    description: "Import an authorized_user Application Default Credentials document for Gemini native routing.",
    transport: "gemini-native",
    connectionMode: "session_import",
    available: true,
    providerType: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com",
    documentationUrl: "https://cloud.google.com/docs/authentication/application-default-credentials",
  },
  {
    id: "github-copilot",
    name: "GitHub Copilot",
    description: "OAuth is supported through a dedicated native bridge; it is not an OpenAI-compatible upstream.",
    transport: "native-bridge",
    connectionMode: "native_bridge",
    available: false,
    availabilityNote: "Requires a separately deployed Copilot bridge before this connection can be enabled.",
    providerType: "custom",
    baseUrl: "",
    documentationUrl: "https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli",
  },
  {
    id: "cursor-official-api",
    name: "Cursor Official API",
    description: "Official API-key integration for supported Cursor API products. Cursor IDE subscription transport is intentionally not imported.",
    transport: "cursor-official",
    connectionMode: "api_key",
    available: false,
    availabilityNote: "An IsoRoute Cursor official API executor is not installed yet.",
    providerType: "custom",
    baseUrl: "https://api.cursor.com",
    documentationUrl: "https://cursor.com/docs/api",
  },
] as const;

export interface CreateBuiltinConnectionInput {
  catalogId: string;
  label: string;
  sessionJson: string;
  idFactory?: () => string;
}

function readObject(json: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("Invalid session JSON format");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Session JSON must be an object");
  }
  return parsed as Record<string, unknown>;
}

function requiredString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Google ADC field '${key}' is required`);
  }
  return value.trim();
}

function safeConnectionId(label: string): string {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36) || "connection";
  return `google-adc-${slug}-${crypto.randomUUID().slice(0, 8)}`;
}

export class OAuthManager {
  /**
   * Check if token is expired or close to expiry (2 minute threshold),
   * and refresh it via the standard OAuth 2.0 refresh grant.
   */
  static async getValidAccessToken(
    provider: Provider,
    persistRefreshedProvider?: (updatedProvider: Provider) => Promise<void>,
  ): Promise<string | undefined> {
    if (!provider.oauth) return undefined;

    const oauth = provider.oauth;
    if (oauth.accessToken && oauth.expiresAt && Date.now() < oauth.expiresAt - 60_000) {
      return oauth.accessToken;
    }

    if (oauth.refreshToken && oauth.tokenEndpoint) {
      const refreshed = await this.refreshTokens(oauth);
      if (refreshed) {
        oauth.accessToken = refreshed.accessToken;
        oauth.expiresAt = refreshed.expiresAt;
        if (refreshed.refreshToken) oauth.refreshToken = refreshed.refreshToken;
        if (persistRefreshedProvider) {
          await persistRefreshedProvider(provider);
        }
        return oauth.accessToken;
      }
    }

    return oauth.accessToken || provider.apiKey;
  }

  /** Execute RFC 6749 refresh-token grant. */
  static async refreshTokens(oauth: ProviderOAuth): Promise<{ accessToken: string; refreshToken?: string; expiresAt: number } | null> {
    if (!oauth.tokenEndpoint || !oauth.refreshToken) return null;

    try {
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: oauth.refreshToken,
      });
      if (oauth.clientId) body.append("client_id", oauth.clientId);
      if (oauth.clientSecret) body.append("client_secret", oauth.clientSecret);

      const res = await fetch(oauth.tokenEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: body.toString(),
      });

      if (!res.ok) {
        console.error(`OAuth refresh failed (${res.status})`);
        return null;
      }

      const data = await res.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
      if (!data.access_token) {
        console.error("OAuth refresh response did not include an access token");
        return null;
      }

      return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
      };
    } catch (err) {
      console.error("OAuth refresh error:", err instanceof Error ? err.message : "unknown error");
      return null;
    }
  }

  /**
   * Parses only fields IsoRoute needs. The raw credential document is never retained.
   */
  static parseSessionJson(jsonStr: string): Partial<ProviderOAuth> {
    const parsed = readObject(jsonStr);

    if (parsed.refresh_token && parsed.client_id) {
      return {
        type: "session_json",
        clientId: String(parsed.client_id),
        clientSecret: parsed.client_secret ? String(parsed.client_secret) : undefined,
        refreshToken: String(parsed.refresh_token),
        tokenEndpoint: parsed.token_uri ? String(parsed.token_uri) : "https://oauth2.googleapis.com/token",
      };
    }

    if (parsed.tokens && typeof parsed.tokens === "object" && !Array.isArray(parsed.tokens)) {
      const tokens = parsed.tokens as Record<string, unknown>;
      return {
        type: "session_json",
        accessToken: tokens.access_token ? String(tokens.access_token) : undefined,
        refreshToken: tokens.refresh_token ? String(tokens.refresh_token) : undefined,
        expiresAt: tokens.expiry ? Number(tokens.expiry) : undefined,
      };
    }

    if (parsed.access_token) {
      return {
        type: "session_json",
        accessToken: String(parsed.access_token),
        refreshToken: parsed.refresh_token ? String(parsed.refresh_token) : undefined,
        expiresAt: parsed.expires_at ? Number(parsed.expires_at) : undefined,
      };
    }

    throw new Error("Unsupported session JSON format");
  }

  static createBuiltinConnection(input: CreateBuiltinConnectionInput): Provider {
    const definition = BUILTIN_OAUTH_PROVIDER_CATALOG.find((item) => item.id === input.catalogId);
    if (!definition) throw new Error("Unknown built-in provider");
    if (definition.connectionMode !== "session_import") {
      throw new Error(`${definition.name} does not support session import`);
    }

    const label = input.label.trim();
    if (!label) throw new Error("Connection label is required");

    if (definition.id === "google-adc") {
      const document = readObject(input.sessionJson);
      if (document.type !== "authorized_user") {
        throw new Error("Google ADC document type must be 'authorized_user'");
      }
      const tokenEndpoint = typeof document.token_uri === "string" ? document.token_uri.trim() : "https://oauth2.googleapis.com/token";
      if (tokenEndpoint !== "https://oauth2.googleapis.com/token") {
        throw new Error("Google ADC token endpoint is not trusted");
      }

      return {
        id: input.idFactory?.() ?? safeConnectionId(label),
        name: label,
        baseUrl: definition.baseUrl,
        type: definition.providerType,
        enabled: true,
        connection: {
          catalogId: definition.id,
          transport: definition.transport,
          status: "active",
          createdAt: Date.now(),
        },
        oauth: {
          type: "refresh_token",
          clientId: requiredString(document, "client_id"),
          clientSecret: requiredString(document, "client_secret"),
          refreshToken: requiredString(document, "refresh_token"),
          tokenEndpoint,
        },
      };
    }

    throw new Error(`No session importer is implemented for ${definition.name}`);
  }
}
