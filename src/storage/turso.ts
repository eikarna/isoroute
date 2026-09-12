// Turso (libSQL) HTTP Storage Adapter for Edge & Serverless Deployment
// Uses pure standard Web APIs (fetch) with zero npm dependencies.
import type { StorageAdapter, LogQueryOptions, MetricQueryOptions } from "./index";
import type { ModelCombo, Provider, TelemetryLog } from "../types";
import type { ApiKeyRecord } from "../core/keys";
import type { RouteRule } from "../core/rewrite";

type TursoValue =
  | { type: "null" }
  | { type: "integer"; value: string }
  | { type: "float"; value: number }
  | { type: "text"; value: string }
  | { type: "blob"; base64: string };

function toTursoArg(val: unknown): TursoValue {
  if (val === null || val === undefined) {
    return { type: "null" };
  }
  if (typeof val === "number") {
    if (Number.isInteger(val)) {
      return { type: "integer", value: String(val) };
    }
    return { type: "float", value: val };
  }
  if (typeof val === "boolean") {
    return { type: "integer", value: val ? "1" : "0" };
  }
  return { type: "text", value: String(val) };
}

function fromTursoValue(v: TursoValue): any {
  if (v.type === "null") return null;
  if (v.type === "integer") return parseInt(v.value, 10);
  if (v.type === "float") return v.value;
  if (v.type === "text") return v.value;
  if (v.type === "blob") return v.base64;
  return null;
}

export class TursoStorageAdapter implements StorageAdapter {
  private pipelineUrl: string;
  private authToken: string;

  constructor(databaseUrl: string, authToken: string) {
    let url = databaseUrl.trim();
    // Normalize libsql:// to https://
    if (url.startsWith("libsql://")) {
      url = "https://" + url.slice("libsql://".length);
    }
    if (!url.endsWith("/v2/pipeline")) {
      url = url.replace(/\/+$/, "") + "/v2/pipeline";
    }
    this.pipelineUrl = url;
    this.authToken = authToken.trim();
  }

  private async execute(sql: string, args: unknown[] = []): Promise<Record<string, any>[]> {
    const tursoArgs = args.map(toTursoArg);
    const body = {
      requests: [
        {
          type: "execute",
          stmt: {
            sql,
            args: tursoArgs,
          },
        },
        { type: "close" },
      ],
    };

    const res = await fetch(this.pipelineUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Turso HTTP Error (${res.status}): ${errText}`);
    }

    const data = (await res.json()) as any;
    const execResult = data.results?.[0];
    if (execResult?.type === "error") {
      throw new Error(`Turso Query Error: ${execResult.error?.message || "Unknown error"}`);
    }

    const resultObj = execResult?.response?.result;
    if (!resultObj || !resultObj.cols || !resultObj.rows) {
      return [];
    }

    const cols: string[] = resultObj.cols.map((c: any) => c.name);
    const rows: any[][] = resultObj.rows;

    return rows.map((row) => {
      const rowObj: Record<string, any> = {};
      cols.forEach((colName, idx) => {
        rowObj[colName] = fromTursoValue(row[idx]);
      });
      return rowObj;
    });
  }

  async initSchema(): Promise<void> {
    const statements = [
      `CREATE TABLE IF NOT EXISTS providers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        base_url TEXT NOT NULL,
        api_key TEXT,
        type TEXT NOT NULL,
        headers_json TEXT,
        oauth_json TEXT,
        enabled INTEGER DEFAULT 1
      );`,
      `CREATE TABLE IF NOT EXISTS combos (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        description TEXT,
        targets_json TEXT NOT NULL,
        enabled INTEGER DEFAULT 1
      );`,
      `CREATE TABLE IF NOT EXISTS telemetry_logs (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        model TEXT NOT NULL,
        target_provider TEXT NOT NULL,
        target_model TEXT NOT NULL,
        status INTEGER NOT NULL,
        latency_ms INTEGER NOT NULL,
        tokens INTEGER NOT NULL,
        prompt_tokens INTEGER DEFAULT 0,
        completion_tokens INTEGER DEFAULT 0
      );`,
      `CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON telemetry_logs (timestamp DESC);`,
      `CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        key TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        max_requests INTEGER,
        max_tokens INTEGER,
        max_prompt_tokens INTEGER,
        max_completion_tokens INTEGER,
        used_requests INTEGER DEFAULT 0,
        used_tokens INTEGER DEFAULT 0,
        used_prompt_tokens INTEGER DEFAULT 0,
        used_completion_tokens INTEGER DEFAULT 0,
        required_headers TEXT,
        required_body_keywords TEXT,
        allowed_models TEXT,
        enabled INTEGER DEFAULT 1
      );`,
      `CREATE INDEX IF NOT EXISTS idx_api_keys_key ON api_keys (key);`,
      `CREATE TABLE IF NOT EXISTS route_rules (
        id TEXT PRIMARY KEY,
        pattern TEXT NOT NULL,
        target TEXT NOT NULL,
        priority INTEGER DEFAULT 10,
        enabled INTEGER DEFAULT 1
      );`,
      `CREATE INDEX IF NOT EXISTS idx_route_rules_priority ON route_rules (priority DESC);`,
    ];

    for (const sql of statements) {
      await this.execute(sql);
    }
  }

  // Providers
  async getProviders(): Promise<Provider[]> {
    const rows = await this.execute("SELECT * FROM providers ORDER BY id ASC");
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
    const rows = await this.execute("SELECT * FROM providers WHERE id = ? LIMIT 1", [id]);
    if (rows.length === 0) return null;
    const r = rows[0];
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
    await this.execute(
      `INSERT INTO providers (id, name, base_url, api_key, type, headers_json, oauth_json, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         base_url = excluded.base_url,
         api_key = excluded.api_key,
         type = excluded.type,
         headers_json = excluded.headers_json,
         oauth_json = excluded.oauth_json,
         enabled = excluded.enabled;`,
      [
        p.id,
        p.name,
        p.baseUrl,
        p.apiKey ?? null,
        p.type,
        p.headers ? JSON.stringify(p.headers) : null,
        p.oauth ? JSON.stringify(p.oauth) : null,
        p.enabled ? 1 : 0,
      ]
    );
  }

  async deleteProvider(id: string): Promise<void> {
    await this.execute("DELETE FROM providers WHERE id = ?", [id]);
  }

  // Combos
  async getCombos(): Promise<ModelCombo[]> {
    const rows = await this.execute("SELECT * FROM combos ORDER BY id ASC");
    return rows.map((r) => ({
      id: r.id,
      displayName: r.display_name,
      description: r.description ?? undefined,
      targets: JSON.parse(r.targets_json),
      enabled: Boolean(r.enabled),
    }));
  }

  async getCombo(id: string): Promise<ModelCombo | null> {
    const rows = await this.execute("SELECT * FROM combos WHERE id = ? LIMIT 1", [id]);
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      id: r.id,
      displayName: r.display_name,
      description: r.description ?? undefined,
      targets: JSON.parse(r.targets_json),
      enabled: Boolean(r.enabled),
    };
  }

  async saveCombo(c: ModelCombo): Promise<void> {
    await this.execute(
      `INSERT INTO combos (id, display_name, description, targets_json, enabled)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         display_name = excluded.display_name,
         description = excluded.description,
         targets_json = excluded.targets_json,
         enabled = excluded.enabled;`,
      [c.id, c.displayName, c.description ?? null, JSON.stringify(c.targets), c.enabled ? 1 : 0]
    );
  }

  async deleteCombo(id: string): Promise<void> {
    await this.execute("DELETE FROM combos WHERE id = ?", [id]);
  }

  // Telemetry Logs
  async recordLog(log: TelemetryLog): Promise<void> {
    await this.execute(
      `INSERT INTO telemetry_logs (id, timestamp, model, target_provider, target_model, status, latency_ms, tokens, prompt_tokens, completion_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        log.id,
        log.timestamp,
        log.model,
        log.targetProvider,
        log.targetModel,
        log.status,
        log.latencyMs,
        log.tokens,
        log.promptTokens ?? 0,
        log.completionTokens ?? 0,
      ]
    );
  }

  async getLogs(options: LogQueryOptions | number = 100): Promise<TelemetryLog[]> {
    const opts: LogQueryOptions = typeof options === "number" ? { limit: options } : options;
    const whereClauses: string[] = [];
    const params: unknown[] = [];

    if (opts.since !== undefined && opts.until !== undefined && opts.since > opts.until) {
      return [];
    }

    if (opts.since !== undefined) {
      whereClauses.push("timestamp >= ?");
      params.push(opts.since);
    }
    if (opts.until !== undefined) {
      whereClauses.push("timestamp <= ?");
      params.push(opts.until);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
    const allowedSort = ["timestamp", "latency", "tokens", "prompt_tokens", "completion_tokens"];
    const sortCol = opts.sortBy && allowedSort.includes(opts.sortBy) ? (opts.sortBy === "latency" ? "latency_ms" : opts.sortBy) : "timestamp";
    const sortOrder = opts.order === "asc" ? "ASC" : "DESC";

    const limit = opts.limit !== undefined ? Math.max(0, opts.limit) : 100;
    if (limit === 0) return [];
    params.push(limit);

    const rows = await this.execute(
      `SELECT * FROM telemetry_logs ${whereSql} ORDER BY ${sortCol} ${sortOrder} LIMIT ?;`,
      params
    );

    return rows.map((r) => ({
      id: r.id,
      timestamp: r.timestamp,
      model: r.model,
      targetProvider: r.target_provider,
      targetModel: r.target_model,
      status: r.status,
      latencyMs: r.latency_ms,
      tokens: r.tokens,
      promptTokens: r.prompt_tokens,
      completionTokens: r.completion_tokens,
    }));
  }

  async clearLogs(): Promise<void> {
    await this.execute("DELETE FROM telemetry_logs;");
  }

  async getMetrics(options: MetricQueryOptions = {}): Promise<{ totalRequests: number; totalTokens: number; promptTokens: number; completionTokens: number }> {
    const whereClauses: string[] = [];
    const params: unknown[] = [];

    if (options.since !== undefined && options.until !== undefined && options.since > options.until) {
      return { totalRequests: 0, totalTokens: 0, promptTokens: 0, completionTokens: 0 };
    }

    if (options.since !== undefined) {
      whereClauses.push("timestamp >= ?");
      params.push(options.since);
    }
    if (options.until !== undefined) {
      whereClauses.push("timestamp <= ?");
      params.push(options.until);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
    const rows = await this.execute(
      `SELECT 
        COUNT(*) as total_requests,
        COALESCE(SUM(tokens), 0) as total_tokens,
        COALESCE(SUM(prompt_tokens), 0) as prompt_tokens,
        COALESCE(SUM(completion_tokens), 0) as completion_tokens
      FROM telemetry_logs ${whereSql};`,
      params
    );

    const r = rows[0];
    return {
      totalRequests: r?.total_requests ?? 0,
      totalTokens: r?.total_tokens ?? 0,
      promptTokens: r?.prompt_tokens ?? 0,
      completionTokens: r?.completion_tokens ?? 0,
    };
  }

  // Consumer API Keys
  async getKeys(): Promise<ApiKeyRecord[]> {
    const rows = await this.execute("SELECT * FROM api_keys ORDER BY created_at DESC");
    return rows.map((r) => ({
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
      requiredHeaders: r.required_headers ? JSON.parse(r.required_headers) : undefined,
      requiredBodyKeywords: r.required_body_keywords ? JSON.parse(r.required_body_keywords) : undefined,
      allowedModels: r.allowed_models ? JSON.parse(r.allowed_models) : undefined,
      enabled: Boolean(r.enabled),
    }));
  }

  async getKey(keyString: string): Promise<ApiKeyRecord | null> {
    const rows = await this.execute("SELECT * FROM api_keys WHERE key = ? LIMIT 1", [keyString]);
    if (rows.length === 0) return null;
    const r = rows[0];
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
      requiredHeaders: r.required_headers ? JSON.parse(r.required_headers) : undefined,
      requiredBodyKeywords: r.required_body_keywords ? JSON.parse(r.required_body_keywords) : undefined,
      allowedModels: r.allowed_models ? JSON.parse(r.allowed_models) : undefined,
      enabled: Boolean(r.enabled),
    };
  }

  async saveKey(k: ApiKeyRecord): Promise<void> {
    await this.execute(
      `INSERT INTO api_keys (
        id, name, key, created_at, expires_at,
        max_requests, max_tokens, max_prompt_tokens, max_completion_tokens,
        used_requests, used_tokens, used_prompt_tokens, used_completion_tokens,
        required_headers, required_body_keywords, allowed_models, enabled
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        expires_at = excluded.expires_at,
        max_requests = excluded.max_requests,
        max_tokens = excluded.max_tokens,
        max_prompt_tokens = excluded.max_prompt_tokens,
        max_completion_tokens = excluded.max_completion_tokens,
        required_headers = excluded.required_headers,
        required_body_keywords = excluded.required_body_keywords,
        allowed_models = excluded.allowed_models,
        enabled = excluded.enabled;`,
      [
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
        k.enabled ? 1 : 0,
      ]
    );
  }

  async deleteKey(id: string): Promise<void> {
    await this.execute("DELETE FROM api_keys WHERE id = ?", [id]);
  }

  async deductKeyUsage(
    id: string,
    usage: { requests?: number; tokens?: number; promptTokens?: number; completionTokens?: number }
  ): Promise<void> {
    await this.execute(
      `UPDATE api_keys SET
        used_requests = used_requests + ?,
        used_tokens = used_tokens + ?,
        used_prompt_tokens = used_prompt_tokens + ?,
        used_completion_tokens = used_completion_tokens + ?
      WHERE id = ?;`,
      [
        usage.requests || 0,
        usage.tokens || 0,
        usage.promptTokens || 0,
        usage.completionTokens || 0,
        id,
      ]
    );
  }

  // Route Rules
  async getRules(): Promise<RouteRule[]> {
    const rows = await this.execute("SELECT * FROM route_rules ORDER BY priority DESC");
    return rows.map((r) => ({
      id: r.id,
      pattern: r.pattern,
      target: r.target,
      priority: r.priority,
      enabled: Boolean(r.enabled),
    }));
  }

  async saveRule(rule: RouteRule): Promise<void> {
    await this.execute(
      `INSERT INTO route_rules (id, pattern, target, priority, enabled)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         pattern = excluded.pattern,
         target = excluded.target,
         priority = excluded.priority,
         enabled = excluded.enabled;`,
      [rule.id, rule.pattern, rule.target, rule.priority ?? 0, (rule.enabled ?? true) ? 1 : 0]
    );
  }

  async deleteRule(id: string): Promise<void> {
    await this.execute("DELETE FROM route_rules WHERE id = ?", [id]);
  }
}
