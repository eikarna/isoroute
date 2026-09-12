// Cloudflare D1 Storage Adapter for Edge Deployment
import type { StorageAdapter } from "./index";
import type { ModelCombo, Provider, TelemetryLog } from "../types";

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<D1ExecResult>;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(colName?: string): Promise<T | null>;
  run<T = unknown>(): Promise<D1Result<T>>;
  all<T = unknown>(): Promise<D1Result<T>>;
}

export interface D1Result<T = unknown> {
  results?: T[];
  success: boolean;
  meta: Record<string, unknown>;
}

export interface D1ExecResult {
  count: number;
  duration: number;
}

export class D1StorageAdapter implements StorageAdapter {
  constructor(private db: D1Database) {}

  async getProviders(): Promise<Provider[]> {
    const res = await this.db.prepare("SELECT * FROM providers ORDER BY id ASC").all<any>();
    return (res.results || []).map((r) => ({
      id: r.id,
      name: r.name,
      baseUrl: r.base_url,
      apiKey: r.api_key ?? undefined,
      type: r.type,
      headers: r.headers_json ? JSON.parse(r.headers_json) : undefined,
      oauth: r.oauth_json ? JSON.parse(r.oauth_json) : undefined,
      enabled: Boolean(r.enabled),
    }));
  }

  async getProvider(id: string): Promise<Provider | null> {
    const r = await this.db.prepare("SELECT * FROM providers WHERE id = ?1 LIMIT 1").bind(id).first<any>();
    if (!r) return null;
    return {
      id: r.id,
      name: r.name,
      baseUrl: r.base_url,
      apiKey: r.api_key ?? undefined,
      type: r.type,
      headers: r.headers_json ? JSON.parse(r.headers_json) : undefined,
      oauth: r.oauth_json ? JSON.parse(r.oauth_json) : undefined,
      enabled: Boolean(r.enabled),
    };
  }

  async saveProvider(p: Provider): Promise<void> {
    await this.db.prepare(`
      INSERT INTO providers (id, name, base_url, api_key, type, headers_json, oauth_json, enabled)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        base_url = excluded.base_url,
        api_key = excluded.api_key,
        type = excluded.type,
        headers_json = excluded.headers_json,
        oauth_json = excluded.oauth_json,
        enabled = excluded.enabled;
    `).bind(
      p.id,
      p.name,
      p.baseUrl,
      p.apiKey ?? null,
      p.type || "openai",
      p.headers ? JSON.stringify(p.headers) : null,
      p.oauth ? JSON.stringify(p.oauth) : null,
      p.enabled ? 1 : 0
    ).run();
  }

  async deleteProvider(id: string): Promise<void> {
    await this.db.prepare("DELETE FROM providers WHERE id = ?1").bind(id).run();
  }

  async getCombos(): Promise<ModelCombo[]> {
    const res = await this.db.prepare("SELECT * FROM combos ORDER BY id ASC").all<any>();
    return (res.results || []).map((r) => ({
      id: r.id,
      displayName: r.display_name,
      description: r.description ?? undefined,
      targets: JSON.parse(r.targets_json),
      enabled: Boolean(r.enabled),
    }));
  }

  async getCombo(id: string): Promise<ModelCombo | null> {
    const r = await this.db.prepare("SELECT * FROM combos WHERE id = ?1 LIMIT 1").bind(id).first<any>();
    if (!r) return null;
    return {
      id: r.id,
      displayName: r.display_name,
      description: r.description ?? undefined,
      targets: JSON.parse(r.targets_json),
      enabled: Boolean(r.enabled),
    };
  }

  async saveCombo(c: ModelCombo): Promise<void> {
    await this.db.prepare(`
      INSERT INTO combos (id, display_name, description, targets_json, enabled)
      VALUES (?1, ?2, ?3, ?4, ?5)
      ON CONFLICT(id) DO UPDATE SET
        display_name = excluded.display_name,
        description = excluded.description,
        targets_json = excluded.targets_json,
        enabled = excluded.enabled;
    `).bind(
      c.id,
      c.displayName,
      c.description ?? null,
      JSON.stringify(c.targets),
      c.enabled ? 1 : 0
    ).run();
  }

  async deleteCombo(id: string): Promise<void> {
    await this.db.prepare("DELETE FROM combos WHERE id = ?1").bind(id).run();
  }

  async recordLog(log: TelemetryLog): Promise<void> {
    await this.db.prepare(`
      INSERT INTO telemetry_logs (id, timestamp, model, target_provider, target_model, status, latency_ms, tokens, prompt_tokens, completion_tokens, error)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11);
    `).bind(
      log.id,
      log.timestamp,
      log.model,
      log.targetProvider,
      log.targetModel,
      log.status,
      log.latencyMs,
      log.tokens ?? 0,
      log.promptTokens ?? 0,
      log.completionTokens ?? 0,
      log.error ?? null
    ).run();
  }

  async getLogs(options?: any): Promise<TelemetryLog[]> {
    const opts = typeof options === "number" ? { limit: options } : options || {};
    const limit = opts.limit ?? 50;

    let whereClause = "WHERE 1=1";
    const params: any[] = [];
    if (opts.since !== undefined) {
      whereClause += " AND timestamp >= ?";
      params.push(opts.since);
    }
    if (opts.until !== undefined) {
      whereClause += " AND timestamp <= ?";
      params.push(opts.until);
    }

    let sortCol = "timestamp";
    if (opts.sortBy === "latency") sortCol = "latency_ms";
    else if (opts.sortBy === "tokens") sortCol = "tokens";
    else if (opts.sortBy === "prompt_tokens") sortCol = "prompt_tokens";
    else if (opts.sortBy === "completion_tokens") sortCol = "completion_tokens";

    const order = opts.order === "asc" ? "ASC" : "DESC";
    params.push(limit);

    const sql = `SELECT * FROM telemetry_logs ${whereClause} ORDER BY ${sortCol} ${order} LIMIT ?`;
    const res = await this.db.prepare(sql).bind(...params).all<any>();
    return (res.results || []).map((r) => ({
      id: r.id,
      timestamp: r.timestamp,
      model: r.model,
      targetProvider: r.target_provider,
      targetModel: r.target_model,
      status: r.status,
      latencyMs: r.latency_ms,
      tokens: r.tokens,
      promptTokens: r.prompt_tokens ?? 0,
      completionTokens: r.completion_tokens ?? 0,
      error: r.error ?? undefined,
    }));
  }

  async clearLogs(): Promise<void> {
    await this.db.prepare("DELETE FROM telemetry_logs;").run();
  }

  async getMetrics(options?: any): Promise<any> {
    let whereClause = "WHERE 1=1";
    const params: any[] = [];
    if (options?.since !== undefined) {
      whereClause += " AND timestamp >= ?";
      params.push(options.since);
    }
    if (options?.until !== undefined) {
      whereClause += " AND timestamp <= ?";
      params.push(options.until);
    }

    const sql = `
      SELECT
        COUNT(*) as total_requests,
        COALESCE(SUM(tokens), 0) as total_tokens,
        COALESCE(SUM(prompt_tokens), 0) as prompt_tokens,
        COALESCE(SUM(completion_tokens), 0) as completion_tokens
      FROM telemetry_logs
      ${whereClause}
    `;
    const r = await this.db.prepare(sql).bind(...params).first<any>();
    return {
      totalRequests: r?.total_requests ?? 0,
      totalTokens: r?.total_tokens ?? 0,
      promptTokens: r?.prompt_tokens ?? 0,
      completionTokens: r?.completion_tokens ?? 0,
    };
  }
}
