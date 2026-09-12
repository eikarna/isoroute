// High-Performance Durable SQLite Storage Adapter via bun:sqlite
import { Database } from "bun:sqlite";
import type { StorageAdapter } from "./index";
import type { ModelCombo, Provider, TelemetryLog } from "../types";

export class SqliteStorageAdapter implements StorageAdapter {
  private db: Database;

  constructor(dbPath = "edge-router.db") {
    this.db = new Database(dbPath, { create: true });
    this.init();
  }

  private init(): void {
    this.db.run("PRAGMA journal_mode = WAL;");
    this.db.run("PRAGMA synchronous = NORMAL;");

    this.db.run(`
      CREATE TABLE IF NOT EXISTS providers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        base_url TEXT NOT NULL,
        api_key TEXT,
        type TEXT NOT NULL DEFAULT 'openai',
        headers_json TEXT,
        oauth_json TEXT,
        enabled INTEGER NOT NULL DEFAULT 1
      );
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS combos (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        description TEXT,
        targets_json TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1
      );
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS telemetry_logs (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        model TEXT NOT NULL,
        target_provider TEXT NOT NULL,
        target_model TEXT NOT NULL,
        status INTEGER NOT NULL,
        latency_ms INTEGER NOT NULL,
        tokens INTEGER NOT NULL DEFAULT 0,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        error TEXT
      );
    `);

    try {
      this.db.run("ALTER TABLE telemetry_logs ADD COLUMN prompt_tokens INTEGER NOT NULL DEFAULT 0;");
    } catch {}
    try {
      this.db.run("ALTER TABLE telemetry_logs ADD COLUMN completion_tokens INTEGER NOT NULL DEFAULT 0;");
    } catch {}

    this.db.run(`CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON telemetry_logs (timestamp DESC);`);
  }

  async getProviders(): Promise<Provider[]> {
    const query = this.db.query("SELECT * FROM providers ORDER BY id ASC");
    const rows = query.all() as any[];
    return rows.map((r) => ({
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
    const query = this.db.query("SELECT * FROM providers WHERE id = ?1 LIMIT 1");
    const r = query.get(id) as any;
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
    const stmt = this.db.prepare(`
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
    `);
    stmt.run(
      p.id,
      p.name,
      p.baseUrl,
      p.apiKey ?? null,
      p.type || "openai",
      p.headers ? JSON.stringify(p.headers) : null,
      p.oauth ? JSON.stringify(p.oauth) : null,
      p.enabled ? 1 : 0
    );
  }

  async deleteProvider(id: string): Promise<void> {
    const stmt = this.db.prepare("DELETE FROM providers WHERE id = ?1");
    stmt.run(id);
  }

  async getCombos(): Promise<ModelCombo[]> {
    const query = this.db.query("SELECT * FROM combos ORDER BY id ASC");
    const rows = query.all() as any[];
    return rows.map((r) => ({
      id: r.id,
      displayName: r.display_name,
      description: r.description ?? undefined,
      targets: JSON.parse(r.targets_json),
      enabled: Boolean(r.enabled),
    }));
  }

  async getCombo(id: string): Promise<ModelCombo | null> {
    const query = this.db.query("SELECT * FROM combos WHERE id = ?1 LIMIT 1");
    const r = query.get(id) as any;
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
    const stmt = this.db.prepare(`
      INSERT INTO combos (id, display_name, description, targets_json, enabled)
      VALUES (?1, ?2, ?3, ?4, ?5)
      ON CONFLICT(id) DO UPDATE SET
        display_name = excluded.display_name,
        description = excluded.description,
        targets_json = excluded.targets_json,
        enabled = excluded.enabled;
    `);
    stmt.run(
      c.id,
      c.displayName,
      c.description ?? null,
      JSON.stringify(c.targets),
      c.enabled ? 1 : 0
    );
  }

  async deleteCombo(id: string): Promise<void> {
    const stmt = this.db.prepare("DELETE FROM combos WHERE id = ?1");
    stmt.run(id);
  }

  async recordLog(log: TelemetryLog): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO telemetry_logs (id, timestamp, model, target_provider, target_model, status, latency_ms, tokens, prompt_tokens, completion_tokens, error)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11);
    `);
    stmt.run(
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
    );

    // Prune old logs keeping latest 1000 records
    this.db.run(`
      DELETE FROM telemetry_logs WHERE id NOT IN (
        SELECT id FROM telemetry_logs ORDER BY timestamp DESC LIMIT 1000
      );
    `);
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
    const rows = this.db.query(sql).all(...params) as any[];

    return rows.map((r) => ({
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
    this.db.run("DELETE FROM telemetry_logs;");
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
    const row = this.db.query(sql).get(...params) as any;
    return {
      totalRequests: row?.total_requests ?? 0,
      totalTokens: row?.total_tokens ?? 0,
      promptTokens: row?.prompt_tokens ?? 0,
      completionTokens: row?.completion_tokens ?? 0,
    };
  }

  close(): void {
    this.db.close();
  }
}
