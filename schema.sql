-- D1 Database Schema for EdgeRouter Serverless Deployment

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

CREATE TABLE IF NOT EXISTS combos (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  description TEXT,
  targets_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1
);

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

CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON telemetry_logs (timestamp DESC);

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
CREATE INDEX IF NOT EXISTS idx_keys_key ON api_keys (key);

CREATE TABLE IF NOT EXISTS route_rules (
  id TEXT PRIMARY KEY,
  pattern TEXT NOT NULL,
  target TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_rules_prio ON route_rules (priority DESC);

