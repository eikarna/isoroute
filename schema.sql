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
