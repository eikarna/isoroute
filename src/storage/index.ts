// Storage Adapter Abstraction: Stateless & Edge-First
import type { Provider, ModelCombo, TelemetryLog } from "../types";

export interface LogQueryOptions {
  limit?: number;
  since?: number;
  until?: number;
  sortBy?: "timestamp" | "latency" | "tokens" | "prompt_tokens" | "completion_tokens";
  order?: "asc" | "desc";
}

export interface MetricQueryOptions {
  since?: number;
  until?: number;
}

export interface StorageMetrics {
  totalRequests: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
}

export interface StorageAdapter {
  getProviders(): Promise<Provider[]>;
  getProvider(id: string): Promise<Provider | null>;
  saveProvider(provider: Provider): Promise<void>;
  deleteProvider(id: string): Promise<void>;

  getCombos(): Promise<ModelCombo[]>;
  getCombo(id: string): Promise<ModelCombo | null>;
  saveCombo(combo: ModelCombo): Promise<void>;
  deleteCombo(id: string): Promise<void>;

  recordLog(log: TelemetryLog): Promise<void>;
  getLogs(options?: LogQueryOptions | number): Promise<TelemetryLog[]>;
  clearLogs(): Promise<void>;
  getMetrics(options?: MetricQueryOptions): Promise<StorageMetrics>;
}

/**
 * Universal In-Memory & KV-compatible storage adapter
 */
export class MemoryStorageAdapter implements StorageAdapter {
  private providers = new Map<string, Provider>();
  private combos = new Map<string, ModelCombo>();
  private logs: TelemetryLog[] = [];
  private totalTokens = 0;

  constructor(initialData?: { providers?: Provider[]; combos?: ModelCombo[] }) {
    if (initialData?.providers) {
      for (const p of initialData.providers) this.providers.set(p.id, p);
    }
    if (initialData?.combos) {
      for (const c of initialData.combos) this.combos.set(c.id, c);
    }
  }

  async getProviders(): Promise<Provider[]> {
    return Array.from(this.providers.values());
  }

  async getProvider(id: string): Promise<Provider | null> {
    return this.providers.get(id) ?? null;
  }

  async saveProvider(provider: Provider): Promise<void> {
    this.providers.set(provider.id, provider);
  }

  async deleteProvider(id: string): Promise<void> {
    this.providers.delete(id);
  }

  async getCombos(): Promise<ModelCombo[]> {
    return Array.from(this.combos.values());
  }

  async getCombo(id: string): Promise<ModelCombo | null> {
    return this.combos.get(id) ?? null;
  }

  async saveCombo(combo: ModelCombo): Promise<void> {
    this.combos.set(combo.id, combo);
  }

  async deleteCombo(id: string): Promise<void> {
    this.combos.delete(id);
  }

  async recordLog(log: TelemetryLog): Promise<void> {
    this.logs.unshift(log);
    if (this.logs.length > 100) this.logs.pop();
    if (log.tokens) this.totalTokens += log.tokens;
  }

  async getLogs(options?: LogQueryOptions | number): Promise<TelemetryLog[]> {
    let filtered = [...this.logs];
    const opts: LogQueryOptions = typeof options === "number" ? { limit: options } : options || {};

    if (opts.since !== undefined) {
      filtered = filtered.filter((l) => l.timestamp >= opts.since!);
    }
    if (opts.until !== undefined) {
      filtered = filtered.filter((l) => l.timestamp <= opts.until!);
    }

    const sortCol = opts.sortBy || "timestamp";
    const order = opts.order || "desc";

    filtered.sort((a, b) => {
      let vA = 0;
      let vB = 0;
      if (sortCol === "timestamp") { vA = a.timestamp; vB = b.timestamp; }
      else if (sortCol === "latency") { vA = a.latencyMs; vB = b.latencyMs; }
      else if (sortCol === "tokens") { vA = a.tokens ?? 0; vB = b.tokens ?? 0; }
      else if (sortCol === "prompt_tokens") { vA = a.promptTokens ?? 0; vB = b.promptTokens ?? 0; }
      else if (sortCol === "completion_tokens") { vA = a.completionTokens ?? 0; vB = b.completionTokens ?? 0; }
      return order === "asc" ? vA - vB : vB - vA;
    });

    const limit = opts.limit ?? 50;
    return filtered.slice(0, limit);
  }

  async clearLogs(): Promise<void> {
    this.logs = [];
    this.totalTokens = 0;
  }

  async getMetrics(options?: MetricQueryOptions): Promise<StorageMetrics> {
    let filtered = this.logs;
    if (options?.since !== undefined) {
      filtered = filtered.filter((l) => l.timestamp >= options.since!);
    }
    if (options?.until !== undefined) {
      filtered = filtered.filter((l) => l.timestamp <= options.until!);
    }

    const totalRequests = filtered.length;
    let totalTokens = 0;
    let promptTokens = 0;
    let completionTokens = 0;

    for (const l of filtered) {
      totalTokens += l.tokens ?? 0;
      promptTokens += l.promptTokens ?? 0;
      completionTokens += l.completionTokens ?? 0;
    }

    return { totalRequests, totalTokens, promptTokens, completionTokens };
  }
}
