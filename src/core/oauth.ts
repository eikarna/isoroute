// JIT (Just-In-Time) OAuth Token Management & Session JSON Parser
import type { Provider, ProviderOAuth } from "../types";

export class OAuthManager {
  /**
   * Check if token is expired or close to expiry (2 minute threshold),
   * and refresh it via standard OAuth 2.0 refresh grant.
   */
  static async getValidAccessToken(provider: Provider): Promise<string | undefined> {
    if (!provider.oauth) {
      return provider.apiKey;
    }

    const oauth = provider.oauth;

    // Direct access token present and still valid for at least 60 seconds
    if (oauth.accessToken && oauth.expiresAt && Date.now() < oauth.expiresAt - 60_000) {
      return oauth.accessToken;
    }

    // Refresh token flow
    if (oauth.refreshToken && oauth.tokenEndpoint) {
      const refreshed = await this.refreshTokens(oauth);
      if (refreshed) {
        oauth.accessToken = refreshed.accessToken;
        oauth.expiresAt = refreshed.expiresAt;
        if (refreshed.refreshToken) {
          oauth.refreshToken = refreshed.refreshToken;
        }
        return oauth.accessToken;
      }
    }

    return oauth.accessToken || provider.apiKey;
  }

  /**
   * Execute standard RFC 6749 refresh grant
   */
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
        console.error(`OAuth refresh failed (${res.status}):`, await res.text());
        return null;
      }

      const data = await res.json() as {
        access_token: string;
        refresh_token?: string;
        expires_in?: number;
      };

      const expiresIn = data.expires_in ?? 3600;
      return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: Date.now() + expiresIn * 1000,
      };
    } catch (err) {
      console.error("OAuth refresh error:", err);
      return null;
    }
  }

  /**
   * Parse uploaded session JSON from tools like Kiro, Codex CLI, or Google ADC
   */
  static parseSessionJson(jsonStr: string): Partial<ProviderOAuth> {
    try {
      const parsed = JSON.parse(jsonStr) as Record<string, unknown>;

      // Google / Antigravity format
      if (parsed.refresh_token && parsed.client_id) {
        return {
          type: "session_json",
          clientId: String(parsed.client_id),
          clientSecret: parsed.client_secret ? String(parsed.client_secret) : undefined,
          refreshToken: String(parsed.refresh_token),
          tokenEndpoint: parsed.token_uri ? String(parsed.token_uri) : "https://oauth2.googleapis.com/token",
          rawSessionJson: jsonStr,
        };
      }

      // Kiro / Codex custom format
      if (parsed.tokens && typeof parsed.tokens === "object") {
        const tokens = parsed.tokens as Record<string, unknown>;
        return {
          type: "session_json",
          accessToken: tokens.access_token ? String(tokens.access_token) : undefined,
          refreshToken: tokens.refresh_token ? String(tokens.refresh_token) : undefined,
          expiresAt: tokens.expiry ? Number(tokens.expiry) : undefined,
          rawSessionJson: jsonStr,
        };
      }

      // Generic Bearer / access token dump
      if (parsed.access_token) {
        return {
          type: "session_json",
          accessToken: String(parsed.access_token),
          refreshToken: parsed.refresh_token ? String(parsed.refresh_token) : undefined,
          expiresAt: parsed.expires_at ? Number(parsed.expires_at) : undefined,
          rawSessionJson: jsonStr,
        };
      }

      return {
        type: "session_json",
        rawSessionJson: jsonStr,
      };
    } catch {
      throw new Error("Invalid session JSON format");
    }
  }
}
