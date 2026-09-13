// Cloudflare D1 Storage Adapter for Edge Deployment
import type { StorageAdapter } from "./index";
import type { ModelCombo, Provider, TelemetryLog } from "../types";
import type { ApiKeyRecord } from "../core/keys";
import type { RouteRule } from "../core/rewrite";

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
      strategy: (r.strategy as any) || "fallback",
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
      strategy: (r.strategy as any) || "fallback",
    };
  }

  async saveCombo(c: ModelCombo): Promise<void> {
    await this.db.prepare(`
      INSERT INTO combos (id, display_name, description, targets_json, enabled, strategy)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6)
      ON CONFLICT(id) DO UPDATE SET
        display_name = excluded.display_name,
        description = excluded.description,
        targets_json = excluded.targets_json,
        enabled = excluded.enabled,
        strategy = excluded.strategy;
    `).bind(
      c.id,
      c.displayName,
      c.description ?? null,
      JSON.stringify(c.targets),
      c.enabled !== false ? 1 : 0,
      c.strategy || "fallback"
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

  // Consumer API Keys
  async getKeys(): Promise<ApiKeyRecord[]> {
    const res = await this.db.prepare("SELECT * FROM api_keys ORDER BY created_at DESC").all<any>();
    return (res.results || []).map((r) => this.mapApiKey(r));
  }

  async getKey(keyOrId: string): Promise<ApiKeyRecord | null> {
    const r = await this.db.prepare("SELECT * FROM api_keys WHERE id = ?1 OR key = ?1 LIMIT 1").bind(keyOrId).first<any>();
    if (!r) return null;
    return this.mapApiKey(r);
  }

  async saveKey(k: ApiKeyRecord): Promise<void> {
    await this.db.prepare(`
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
    `).bind(
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
    ).run();
  }

  async deleteKey(id: string): Promise<void> {
    await this.db.prepare("DELETE FROM api_keys WHERE id = ?1").bind(id).run();
  }

  async deductKeyUsage(id: string, usage: { requests?: number; tokens?: number; promptTokens?: number; completionTokens?: number }): Promise<void> {
    await this.db.prepare(`
      UPDATE api_keys SET
        used_requests = used_requests + ?2,
        used_tokens = used_tokens + ?3,
        used_prompt_tokens = used_prompt_tokens + ?4,
        used_completion_tokens = used_completion_tokens + ?5
      WHERE id = ?1
    `).bind(
      id,
      usage.requests ?? 1,
      usage.tokens ?? 0,
      usage.promptTokens ?? 0,
      usage.completionTokens ?? 0
    ).run();
  }

  // Route Rules
  async getRules(): Promise<RouteRule[]> {
    const res = await this.db.prepare("SELECT * FROM route_rules ORDER BY priority DESC").all<any>();
    return (res.results || []).map((r) => ({
      id: r.id,
      pattern: r.pattern,
      target: r.target,
      priority: r.priority,
      enabled: Boolean(r.enabled),
    }));
  }

  async getRule(id: string): Promise<RouteRule | null> {
    const r = await this.db.prepare("SELECT * FROM route_rules WHERE id = ?1 LIMIT 1").bind(id).first<any>();
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
    await this.db.prepare(`
      INSERT INTO route_rules (id, pattern, target, priority, enabled)
      VALUES (?1, ?2, ?3, ?4, ?5)
      ON CONFLICT(id) DO UPDATE SET
        pattern = excluded.pattern,
        target = excluded.target,
        priority = excluded.priority,
        enabled = excluded.enabled;
    `).bind(rule.id, rule.pattern, rule.target, rule.priority ?? 0, (rule.enabled ?? true) ? 1 : 0).run();
  }

  async deleteRule(id: string): Promise<void> {
    await this.db.prepare("DELETE FROM route_rules WHERE id = ?1").bind(id).run();
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

  // Chunked D1 Batch execution (safe within D1 100-statement limit per batch)
  async saveProvidersBatch(providers: Provider[]): Promise<number> {
    if (providers.length === 0) return 0;
    const chunkSize = 80;
    for (let i = 0; i < providers.length; i += chunkSize) {
      const chunk = providers.slice(i, i + chunkSize);
      const stmts = chunk.map((p) =>
        this.db.prepare(`
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
        )
      );
      await this.db.batch(stmts);
    }
    return providers.length;
  }

  async saveCombosBatch(combos: ModelCombo[]): Promise<number> {
    if (combos.length === 0) return 0;
    const chunkSize = 80;
    for (let i = 0; i < combos.length; i += chunkSize) {
      const chunk = combos.slice(i, i + chunkSize);
      const stmts = chunk.map((c) =>
        this.db.prepare(`
          INSERT INTO combos (id, display_name, description, targets_json, enabled, strategy)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6)
          ON CONFLICT(id) DO UPDATE SET
            display_name = excluded.display_name,
            description = excluded.description,
            targets_json = excluded.targets_json,
            enabled = excluded.enabled,
            strategy = excluded.strategy;
        `).bind(
          c.id,
          c.displayName,
          c.description ?? null,
          JSON.stringify(c.targets),
          c.enabled !== false ? 1 : 0,
          c.strategy || "fallback"
        )
      );
      await this.db.batch(stmts);
    }
    return combos.length;
  }

  async saveKeysBatch(keys: ApiKeyRecord[]): Promise<number> {
    if (keys.length === 0) return 0;
    const chunkSize = 80;
    for (let i = 0; i < keys.length; i += chunkSize) {
      const chunk = keys.slice(i, i + chunkSize);
      const stmts = chunk.map((k) =>
        this.db.prepare(`
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
        `).bind(
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
        )
      );
      await this.db.batch(stmts);
    }
    return keys.length;
  }
}
