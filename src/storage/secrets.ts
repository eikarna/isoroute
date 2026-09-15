// AES-GCM at-rest protection for upstream provider credentials.
// The wrapper keeps the storage schema unchanged and binds each envelope to its
// provider ID through AES-GCM additional authenticated data (AAD).
import type { Provider, ProviderOAuth } from "../types";
import type { StorageAdapter, LogQueryOptions, MetricQueryOptions, StorageMetrics } from "./index";
import type { ModelCombo, TelemetryLog } from "../types";
import type { ApiKeyRecord } from "../core/keys";
import type { RouteRule } from "../core/rewrite";

interface ProviderSecrets {
  apiKey?: string;
  accessToken?: string;
  refreshToken?: string;
  clientSecret?: string;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(input: string): Uint8Array {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function hasOAuthSecrets(oauth: ProviderOAuth | undefined): oauth is ProviderOAuth {
  return Boolean(oauth?.accessToken || oauth?.refreshToken || oauth?.clientSecret);
}

function isSealedApiKey(value: string | undefined): boolean {
  return Boolean(value?.startsWith("enc.v1."));
}

export class SecretStorageAdapter implements StorageAdapter {
  private readonly encoder = new TextEncoder();

  private constructor(
    private readonly underlying: StorageAdapter,
    private readonly key: CryptoKey,
  ) {}

  static async create(underlying: StorageAdapter, masterKey: string): Promise<SecretStorageAdapter> {
    if (masterKey.trim().length < 32) {
      throw new Error("MASTER_KEY must contain at least 32 characters");
    }
    const material = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(masterKey));
    const key = await crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    return new SecretStorageAdapter(underlying, key);
  }

  private async seal(providerId: string, value: ProviderSecrets): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = this.encoder.encode(JSON.stringify(value));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: this.encoder.encode(`isoroute:provider:${providerId}`) },
      this.key,
      plaintext,
    );
    return `v1.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ciphertext))}`;
  }

  private async open(providerId: string, sealed: string): Promise<ProviderSecrets> {
    const [version, encodedIv, encodedCiphertext] = sealed.split(".");
    if (version !== "v1" || !encodedIv || !encodedCiphertext) {
      throw new Error("Invalid provider credential envelope");
    }
    try {
      const plaintext = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: fromBase64Url(encodedIv),
          additionalData: this.encoder.encode(`isoroute:provider:${providerId}`),
        },
        this.key,
        fromBase64Url(encodedCiphertext),
      );
      const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as ProviderSecrets;
      if (!parsed || typeof parsed !== "object") throw new Error("Invalid provider credential payload");
      return parsed;
    } catch {
      throw new Error("Unable to decrypt provider credentials");
    }
  }

  private async sealProvider(provider: Provider): Promise<Provider> {
    const oauthWithLegacy = provider.oauth as (ProviderOAuth & { rawSessionJson?: unknown }) | undefined;
    const { accessToken, refreshToken, clientSecret, rawSessionJson: _legacyRawSession, ...publicOAuth } = oauthWithLegacy || {};
    const sealedApiKey = provider.apiKey && !isSealedApiKey(provider.apiKey)
      ? `enc.${await this.seal(provider.id, { apiKey: provider.apiKey })}`
      : provider.apiKey;

    const oauth = provider.oauth
      ? {
          ...publicOAuth,
          ...(hasOAuthSecrets(provider.oauth)
            ? { sealed: await this.seal(provider.id, { accessToken, refreshToken, clientSecret }) }
            : {}),
        }
      : undefined;

    return {
      ...provider,
      apiKey: sealedApiKey,
      oauth,
    };
  }

  private async openProvider(provider: Provider | null): Promise<Provider | null> {
    if (!provider) return null;

    let apiKey = provider.apiKey;
    if (isSealedApiKey(apiKey)) {
      const secrets = await this.open(provider.id, apiKey!.slice("enc.".length));
      if (!secrets.apiKey) throw new Error("Provider credential envelope does not include an API key");
      apiKey = secrets.apiKey;
    }

    let oauth = provider.oauth;
    if (oauth?.sealed) {
      const { sealed, ...publicOAuth } = oauth;
      const secrets = await this.open(provider.id, sealed);
      oauth = { ...publicOAuth, ...secrets };
    }

    return { ...provider, apiKey, oauth };
  }

  async getProviders(): Promise<Provider[]> {
    return Promise.all((await this.underlying.getProviders()).map(async (provider) => (await this.openProvider(provider))!));
  }

  async getProvider(id: string): Promise<Provider | null> {
    return this.openProvider(await this.underlying.getProvider(id));
  }

  async saveProvider(provider: Provider): Promise<void> {
    await this.underlying.saveProvider(await this.sealProvider(provider));
  }

  async deleteProvider(id: string): Promise<void> { await this.underlying.deleteProvider(id); }
  async getCombos(): Promise<ModelCombo[]> { return this.underlying.getCombos(); }
  async getCombo(id: string): Promise<ModelCombo | null> { return this.underlying.getCombo(id); }
  async saveCombo(combo: ModelCombo): Promise<void> { await this.underlying.saveCombo(combo); }
  async deleteCombo(id: string): Promise<void> { await this.underlying.deleteCombo(id); }
  async recordLog(log: TelemetryLog): Promise<void> { await this.underlying.recordLog(log); }
  async getLogs(options?: LogQueryOptions | number): Promise<TelemetryLog[]> { return this.underlying.getLogs(options); }
  async clearLogs(): Promise<void> { await this.underlying.clearLogs(); }
  async getMetrics(options?: MetricQueryOptions): Promise<StorageMetrics> { return this.underlying.getMetrics(options); }
  async getKeys(): Promise<ApiKeyRecord[]> { return this.underlying.getKeys(); }
  async getKey(keyOrId: string): Promise<ApiKeyRecord | null> { return this.underlying.getKey(keyOrId); }
  async saveKey(key: ApiKeyRecord): Promise<void> { await this.underlying.saveKey(key); }
  async deleteKey(id: string): Promise<void> { await this.underlying.deleteKey(id); }
  async deductKeyUsage(id: string, usage: { requests?: number; tokens?: number; promptTokens?: number; completionTokens?: number }): Promise<void> {
    await this.underlying.deductKeyUsage(id, usage);
  }
  async getRules(): Promise<RouteRule[]> { return this.underlying.getRules(); }
  async getRule(id: string): Promise<RouteRule | null> { return this.underlying.getRule(id); }
  async saveRule(rule: RouteRule): Promise<void> { await this.underlying.saveRule(rule); }
  async deleteRule(id: string): Promise<void> { await this.underlying.deleteRule(id); }
  async saveProvidersBatch(providers: Provider[]): Promise<number> {
    if (!this.underlying.saveProvidersBatch) {
      for (const provider of providers) await this.saveProvider(provider);
      return providers.length;
    }
    return this.underlying.saveProvidersBatch(await Promise.all(providers.map((provider) => this.sealProvider(provider))));
  }
  async saveCombosBatch(combos: ModelCombo[]): Promise<number> {
    if (!this.underlying.saveCombosBatch) {
      for (const combo of combos) await this.underlying.saveCombo(combo);
      return combos.length;
    }
    return this.underlying.saveCombosBatch(combos);
  }
  async saveKeysBatch(keys: ApiKeyRecord[]): Promise<number> {
    if (!this.underlying.saveKeysBatch) {
      for (const key of keys) await this.underlying.saveKey(key);
      return keys.length;
    }
    return this.underlying.saveKeysBatch(keys);
  }
}

/** Omit all provider credentials from dashboard and management responses. */
export function redactProviderSecrets(provider: Provider): Provider {
  const { apiKey, oauth, ...rest } = provider;
  const keyCount = apiKey ? apiKey.split(/[\n,]/).map((key) => key.trim()).filter(Boolean).length : 0;
  if (!oauth) return { ...rest, keyCount };
  const oauthWithLegacy = oauth as ProviderOAuth & { rawSessionJson?: unknown };
  const { accessToken: _accessToken, refreshToken: _refreshToken, clientSecret: _clientSecret, sealed: _sealed, rawSessionJson: _legacyRawSession, ...safeOAuth } = oauthWithLegacy;
  return {
    ...rest,
    keyCount,
    oauth: {
      ...safeOAuth,
      type: oauth.type,
      expiresAt: oauth.expiresAt,
    },
  };
}
