// High-Performance In-Memory Cached Storage Adapter
// Implements 'Read from RAM, Verify Miss on DB' pattern for sub-millisecond hot-path resolution
import type { StorageAdapter, LogQueryOptions, MetricQueryOptions, StorageMetrics } from "./index";
import type { Provider, ModelCombo, TelemetryLog } from "../types";
import type { ApiKeyRecord } from "../core/keys";
import type { RouteRule } from "../core/rewrite";

export class CachedStorageAdapter implements StorageAdapter {
  private cacheTTLMs: number;
  private providersCache: { data: Provider[]; expiresAt: number } | null = null;
  private combosCache: { data: ModelCombo[]; expiresAt: number } | null = null;
  private rulesCache: { data: RouteRule[]; expiresAt: number } | null = null;
  private keysCache: { data: ApiKeyRecord[]; expiresAt: number } | null = null;

  // Single entity cache for instant O(1) lookups
  private keyMap = new Map<string, { data: ApiKeyRecord; expiresAt: number }>();
  private comboMap = new Map<string, { data: ModelCombo; expiresAt: number }>();
  private providerMap = new Map<string, { data: Provider; expiresAt: number }>();
  private ruleMap = new Map<string, { data: RouteRule; expiresAt: number }>();

  constructor(private underlying: StorageAdapter, ttlMs = 60000) {
    this.cacheTTLMs = ttlMs;
  }

  // --- Providers ---
  async getProviders(): Promise<Provider[]> {
    const now = Date.now();
    if (this.providersCache && this.providersCache.expiresAt > now) {
      return this.providersCache.data;
    }
    const data = await this.underlying.getProviders();
    this.providersCache = { data, expiresAt: now + this.cacheTTLMs };
    for (const p of data) {
      this.providerMap.set(p.id, { data: p, expiresAt: now + this.cacheTTLMs });
    }
    return data;
  }

  async getProvider(id: string): Promise<Provider | null> {
    const now = Date.now();
    const cached = this.providerMap.get(id);
    if (cached && cached.expiresAt > now) {
      return cached.data;
    }
    if (this.providersCache && this.providersCache.expiresAt > now) {
      const found = this.providersCache.data.find((p) => p.id === id);
      if (found) {
        this.providerMap.set(id, { data: found, expiresAt: now + this.cacheTTLMs });
        return found;
      }
    }
    // Read from RAM, Verify Miss on DB
    const fresh = await this.underlying.getProvider(id);
    if (fresh) {
      this.providerMap.set(id, { data: fresh, expiresAt: now + this.cacheTTLMs });
    }
    return fresh;
  }

  async saveProvider(provider: Provider): Promise<void> {
    await this.underlying.saveProvider(provider);
    this.invalidateProviders();
  }

  async deleteProvider(id: string): Promise<void> {
    await this.underlying.deleteProvider(id);
    this.invalidateProviders();
  }

  invalidateProviders(): void {
    this.providersCache = null;
    this.providerMap.clear();
  }

  // --- Combos ---
  async getCombos(): Promise<ModelCombo[]> {
    const now = Date.now();
    if (this.combosCache && this.combosCache.expiresAt > now) {
      return this.combosCache.data;
    }
    const data = await this.underlying.getCombos();
    this.combosCache = { data, expiresAt: now + this.cacheTTLMs };
    for (const c of data) {
      this.comboMap.set(c.id, { data: c, expiresAt: now + this.cacheTTLMs });
    }
    return data;
  }

  async getCombo(id: string): Promise<ModelCombo | null> {
    const now = Date.now();
    const cached = this.comboMap.get(id);
    if (cached && cached.expiresAt > now) {
      return cached.data;
    }
    if (this.combosCache && this.combosCache.expiresAt > now) {
      const found = this.combosCache.data.find((c) => c.id === id);
      if (found) {
        this.comboMap.set(id, { data: found, expiresAt: now + this.cacheTTLMs });
        return found;
      }
    }
    // Read from RAM, Verify Miss on DB
    const fresh = await this.underlying.getCombo(id);
    if (fresh) {
      this.comboMap.set(id, { data: fresh, expiresAt: now + this.cacheTTLMs });
    }
    return fresh;
  }

  async saveCombo(combo: ModelCombo): Promise<void> {
    await this.underlying.saveCombo(combo);
    this.invalidateCombos();
  }

  async deleteCombo(id: string): Promise<void> {
    await this.underlying.deleteCombo(id);
    this.invalidateCombos();
  }

  invalidateCombos(): void {
    this.combosCache = null;
    this.comboMap.clear();
  }

  // --- Consumer Keys ---
  async getKeys(): Promise<ApiKeyRecord[]> {
    const now = Date.now();
    if (this.keysCache && this.keysCache.expiresAt > now) {
      return this.keysCache.data;
    }
    const data = await this.underlying.getKeys();
    this.keysCache = { data, expiresAt: now + this.cacheTTLMs };
    for (const k of data) {
      this.keyMap.set(k.key, { data: k, expiresAt: now + this.cacheTTLMs });
      this.keyMap.set(k.id, { data: k, expiresAt: now + this.cacheTTLMs });
    }
    return data;
  }

  async getKey(keyOrId: string): Promise<ApiKeyRecord | null> {
    const now = Date.now();
    const cached = this.keyMap.get(keyOrId);
    if (cached && cached.expiresAt > now) {
      return cached.data;
    }
    if (this.keysCache && this.keysCache.expiresAt > now) {
      const found = this.keysCache.data.find((k) => k.id === keyOrId || k.key === keyOrId);
      if (found) {
        this.keyMap.set(keyOrId, { data: found, expiresAt: now + this.cacheTTLMs });
        return found;
      }
    }
    // Read from RAM, Verify Miss on DB
    const fresh = await this.underlying.getKey(keyOrId);
    if (fresh) {
      this.keyMap.set(fresh.key, { data: fresh, expiresAt: now + this.cacheTTLMs });
      this.keyMap.set(fresh.id, { data: fresh, expiresAt: now + this.cacheTTLMs });
    }
    return fresh;
  }

  async saveKey(key: ApiKeyRecord): Promise<void> {
    await this.underlying.saveKey(key);
    this.invalidateKeys();
  }

  async deleteKey(id: string): Promise<void> {
    await this.underlying.deleteKey(id);
    this.invalidateKeys();
  }

  async deductKeyUsage(id: string, usage: { requests?: number; tokens?: number; promptTokens?: number; completionTokens?: number }): Promise<void> {
    // Update underlying DB
    await this.underlying.deductKeyUsage(id, usage);
    // Locally adjust cached entry if present
    for (const [_, entry] of this.keyMap.entries()) {
      if (entry.data.id === id) {
        entry.data.usedRequests = (entry.data.usedRequests || 0) + (usage.requests ?? 1);
        entry.data.usedTokens = (entry.data.usedTokens || 0) + (usage.tokens ?? 0);
        entry.data.usedPromptTokens = (entry.data.usedPromptTokens || 0) + (usage.promptTokens ?? 0);
        entry.data.usedCompletionTokens = (entry.data.usedCompletionTokens || 0) + (usage.completionTokens ?? 0);
      }
    }
  }

  invalidateKeys(): void {
    this.keysCache = null;
    this.keyMap.clear();
  }

  // --- Rules ---
  async getRules(): Promise<RouteRule[]> {
    const now = Date.now();
    if (this.rulesCache && this.rulesCache.expiresAt > now) {
      return this.rulesCache.data;
    }
    const data = await this.underlying.getRules();
    this.rulesCache = { data, expiresAt: now + this.cacheTTLMs };
    for (const r of data) {
      this.ruleMap.set(r.id, { data: r, expiresAt: now + this.cacheTTLMs });
    }
    return data;
  }

  async getRule(id: string): Promise<RouteRule | null> {
    const now = Date.now();
    const cached = this.ruleMap.get(id);
    if (cached && cached.expiresAt > now) {
      return cached.data;
    }
    const fresh = await this.underlying.getRule(id);
    if (fresh) {
      this.ruleMap.set(id, { data: fresh, expiresAt: now + this.cacheTTLMs });
    }
    return fresh;
  }

  async saveRule(rule: RouteRule): Promise<void> {
    await this.underlying.saveRule(rule);
    this.invalidateRules();
  }

  async deleteRule(id: string): Promise<void> {
    await this.underlying.deleteRule(id);
    this.invalidateRules();
  }

  invalidateRules(): void {
    this.rulesCache = null;
    this.ruleMap.clear();
  }

  // Invalidate all caches
  invalidateAll(): void {
    this.invalidateProviders();
    this.invalidateCombos();
    this.invalidateKeys();
    this.invalidateRules();
  }

  // --- Logs & Metrics (Direct Passthrough) ---
  recordLog(log: TelemetryLog): Promise<void> {
    return this.underlying.recordLog(log);
  }

  getLogs(options?: LogQueryOptions | number): Promise<TelemetryLog[]> {
    return this.underlying.getLogs(options);
  }

  clearLogs(): Promise<void> {
    return this.underlying.clearLogs();
  }

  getMetrics(options?: MetricQueryOptions): Promise<StorageMetrics> {
    return this.underlying.getMetrics(options);
  }

  // Batch ops passthrough
  saveProvidersBatch(providers: Provider[]): Promise<number> {
    this.invalidateProviders();
    return this.underlying.saveProvidersBatch ? this.underlying.saveProvidersBatch(providers) : Promise.resolve(providers.length);
  }

  saveCombosBatch(combos: ModelCombo[]): Promise<number> {
    this.invalidateCombos();
    return this.underlying.saveCombosBatch ? this.underlying.saveCombosBatch(combos) : Promise.resolve(combos.length);
  }

  saveKeysBatch(keys: ApiKeyRecord[]): Promise<number> {
    this.invalidateKeys();
    return this.underlying.saveKeysBatch ? this.underlying.saveKeysBatch(keys) : Promise.resolve(keys.length);
  }
}
