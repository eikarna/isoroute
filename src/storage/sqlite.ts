// High-Performance Durable SQLite Storage Adapter via bun:sqlite
import { Database } from "bun:sqlite";
import type { StorageAdapter } from "./index";
import type { ModelCombo, Provider, TelemetryLog } from "../types";
import type { ApiKeyRecord } from "../core/keys";
import type { RouteRule } from "../core/rewrite";

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
        enabled INTEGER NOT NULL DEFAULT 1,
        strategy TEXT DEFAULT 'fallback'
      );
    `);
    try {
      this.db.run("ALTER TABLE combos ADD COLUMN strategy TEXT DEFAULT 'fallback'");
    } catch {}

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

    this.db.run(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        key TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        max_requests INTEGER,
        max_tokens INTEGER,
        max_prompt_tokens INTEGER,
        max_completion_tokens INTEGER,
        used_requests INTEGER NOT NULL DEFAULT 0,
        used_tokens INTEGER NOT NULL DEFAULT 0,
        used_prompt_tokens INTEGER NOT NULL DEFAULT 0,
        used_completion_tokens INTEGER NOT NULL DEFAULT 0,
        required_headers_json TEXT,
        required_body_json TEXT,
        allowed_models_json TEXT,
        enabled INTEGER NOT NULL DEFAULT 1
      );
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_keys_key ON api_keys (key);`);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS route_rules (
        id TEXT PRIMARY KEY,
        pattern TEXT NOT NULL,
        target TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1
      );
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_rules_prio ON route_rules (priority DESC);`);
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
    return rows.map((r: any) => ({
      id: r.id,
      displayName: r.display_name,
      description: r.description ?? undefined,
      targets: JSON.parse(r.targets_json),
      enabled: Boolean(r.enabled),
      strategy: (r.strategy as any) || "fallback",
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
      strategy: (r.strategy as any) || "fallback",
    };
  }

  async saveCombo(c: ModelCombo): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO combos (id, display_name, description, targets_json, enabled, strategy)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6)
      ON CONFLICT(id) DO UPDATE SET
        display_name = excluded.display_name,
        description = excluded.description,
        targets_json = excluded.targets_json,
        enabled = excluded.enabled,
        strategy = excluded.strategy;
    `);
    stmt.run(
      c.id,
      c.displayName,
      c.description ?? null,
      JSON.stringify(c.targets),
      c.enabled !== false ? 1 : 0,
      c.strategy || "fallback"
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

  // Consumer API Keys
  async getKeys(): Promise<ApiKeyRecord[]> {
    const rows = this.db.query("SELECT * FROM api_keys ORDER BY created_at DESC").all() as any[];
    return rows.map((r) => this.mapApiKey(r));
  }

  async getKey(keyOrId: string): Promise<ApiKeyRecord | null> {
    const r = this.db.query("SELECT * FROM api_keys WHERE id = ?1 OR key = ?1 LIMIT 1").get(keyOrId) as any;
    if (!r) return null;
    return this.mapApiKey(r);
  }

  async saveKey(k: ApiKeyRecord): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO api_keys (
        id, name, key, created_at, expires_at,
        max_requests, max_tokens, max_prompt_tokens, max_completion_tokens,
        used_requests, used_tokens, used_prompt_tokens, used_completion_tokens,
        required_headers_json, required_body_json, allowed_models_json, enabled
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        key = excluded.key,
        expires_at = excluded.expires_at,
        max_requests = excluded.max_requests,
        max_tokens = excluded.max_tokens,
        max_prompt_tokens = excluded.max_prompt_tokens,
        max_completion_tokens = excluded.max_completion_tokens,
        required_headers_json = excluded.required_headers_json,
        required_body_json = excluded.required_body_json,
        allowed_models_json = excluded.allowed_models_json,
        enabled = excluded.enabled;
    `);

    stmt.run(
      k.id,
      k.name,
      k.key,
      k.createdAt,
      k.expiresAt ?? null,
      k.maxRequests ?? null,
      k.maxTokens ?? null,
      k.maxPromptTokens ?? null,
      k.maxCompletionTokens ?? null,
      k.usedRequests ?? 0,
      k.usedTokens ?? 0,
      k.usedPromptTokens ?? 0,
      k.usedCompletionTokens ?? 0,
      k.requiredHeaders ? JSON.stringify(k.requiredHeaders) : null,
      k.requiredBodyKeywords ? JSON.stringify(k.requiredBodyKeywords) : null,
      k.allowedModels ? JSON.stringify(k.allowedModels) : null,
      k.enabled ? 1 : 0
    );
  }

  async deleteKey(id: string): Promise<void> {
    this.db.prepare("DELETE FROM api_keys WHERE id = ?1").run(id);
  }

  async deductKeyUsage(id: string, usage: { requests?: number; tokens?: number; promptTokens?: number; completionTokens?: number }): Promise<void> {
    const stmt = this.db.prepare(`
      UPDATE api_keys SET
        used_requests = used_requests + ?2,
        used_tokens = used_tokens + ?3,
        used_prompt_tokens = used_prompt_tokens + ?4,
        used_completion_tokens = used_completion_tokens + ?5
      WHERE id = ?1
    `);
    stmt.run(
      id,
      usage.requests ?? 1,
      usage.tokens ?? 0,
      usage.promptTokens ?? 0,
      usage.completionTokens ?? 0
    );
  }

  // Dynamic Route Rules
  async getRules(): Promise<RouteRule[]> {
    const rows = this.db.query("SELECT * FROM route_rules ORDER BY priority DESC").all() as any[];
    return rows.map((r) => ({
      id: r.id,
      pattern: r.pattern,
      target: r.target,
      priority: r.priority,
      enabled: Boolean(r.enabled),
    }));
  }

  async getRule(id: string): Promise<RouteRule | null> {
    const r = this.db.query("SELECT * FROM route_rules WHERE id = ?1 LIMIT 1").get(id) as any;
    if (!r) return null;
    return {
      id: r.id,
      pattern: r.pattern,
      target: r.target,
      priority: r.priority,
      enabled: Boolean(r.enabled),
    };
  }

  async saveRule(rule: RouteRule): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO route_rules (id, pattern, target, priority, enabled)
      VALUES (?1, ?2, ?3, ?4, ?5)
      ON CONFLICT(id) DO UPDATE SET
        pattern = excluded.pattern,
        target = excluded.target,
        priority = excluded.priority,
        enabled = excluded.enabled;
    `);
    stmt.run(rule.id, rule.pattern, rule.target, rule.priority ?? 0, (rule.enabled ?? true) ? 1 : 0);
  }

  async deleteRule(id: string): Promise<void> {
    this.db.prepare("DELETE FROM route_rules WHERE id = ?1").run(id);
  }

  private mapApiKey(r: any): ApiKeyRecord {
    return {
      id: r.id,
      name: r.name,
      key: r.key,
      createdAt: r.created_at,
      expiresAt: r.expires_at ?? undefined,
      maxRequests: r.max_requests ?? undefined,
      maxTokens: r.max_tokens ?? undefined,
      maxPromptTokens: r.max_prompt_tokens ?? undefined,
      maxCompletionTokens: r.max_completion_tokens ?? undefined,
      usedRequests: r.used_requests ?? 0,
      usedTokens: r.used_tokens ?? 0,
      usedPromptTokens: r.used_prompt_tokens ?? 0,
      usedCompletionTokens: r.used_completion_tokens ?? 0,
      requiredHeaders: r.required_headers_json ? JSON.parse(r.required_headers_json) : undefined,
      requiredBodyKeywords: r.required_body_json ? JSON.parse(r.required_body_json) : undefined,
      allowedModels: r.allowed_models_json ? JSON.parse(r.allowed_models_json) : undefined,
      enabled: Boolean(r.enabled),
    };
  }

  // High-performance batch transaction writes for 20k+ entries
  async saveProvidersBatch(providers: Provider[]): Promise<number> {
    if (providers.length === 0) return 0;
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

    const runTx = this.db.transaction((items: Provider[]) => {
      for (const p of items) {
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
    });

    runTx(providers);
    return providers.length;
  }

  async saveCombosBatch(combos: ModelCombo[]): Promise<number> {
    if (combos.length === 0) return 0;
    const stmt = this.db.prepare(`
      INSERT INTO combos (id, display_name, description, targets_json, enabled, strategy)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6)
      ON CONFLICT(id) DO UPDATE SET
        display_name = excluded.display_name,
        description = excluded.description,
        targets_json = excluded.targets_json,
        enabled = excluded.enabled,
        strategy = excluded.strategy;
    `);

    const runTx = this.db.transaction((items: ModelCombo[]) => {
      for (const c of items) {
        stmt.run(
          c.id,
          c.displayName,
          c.description ?? null,
          JSON.stringify(c.targets),
          c.enabled !== false ? 1 : 0,
          c.strategy || "fallback"
        );
      }
    });

    runTx(combos);
    return combos.length;
  }

  async saveKeysBatch(keys: ApiKeyRecord[]): Promise<number> {
    if (keys.length === 0) return 0;
    const stmt = this.db.prepare(`
      INSERT INTO api_keys (
        id, name, key, created_at, expires_at,
        max_requests, max_tokens, max_prompt_tokens, max_completion_tokens,
        used_requests, used_tokens, used_prompt_tokens, used_completion_tokens,
        required_headers_json, required_body_json, allowed_models_json, enabled
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        key = excluded.key,
        expires_at = excluded.expires_at,
        max_requests = excluded.max_requests,
        max_tokens = excluded.max_tokens,
        max_prompt_tokens = excluded.max_prompt_tokens,
        max_completion_tokens = excluded.max_completion_tokens,
        required_headers_json = excluded.required_headers_json,
        required_body_json = excluded.required_body_json,
        allowed_models_json = excluded.allowed_models_json,
        enabled = excluded.enabled;
    `);

    const runTx = this.db.transaction((items: ApiKeyRecord[]) => {
      for (const k of items) {
        stmt.run(
          k.id,
          k.name,
          k.key,
          k.createdAt,
          k.expiresAt ?? null,
          k.maxRequests ?? null,
          k.maxTokens ?? null,
          k.maxPromptTokens ?? null,
          k.maxCompletionTokens ?? null,
          k.usedRequests ?? 0,
          k.usedTokens ?? 0,
          k.usedPromptTokens ?? 0,
          k.usedCompletionTokens ?? 0,
          k.requiredHeaders ? JSON.stringify(k.requiredHeaders) : null,
          k.requiredBodyKeywords ? JSON.stringify(k.requiredBodyKeywords) : null,
          k.allowedModels ? JSON.stringify(k.allowedModels) : null,
          k.enabled ? 1 : 0
        );
      }
    });

    runTx(keys);
    return keys.length;
  }

  close(): void {
    this.db.close();
  }
}
