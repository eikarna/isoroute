// Universal types for Serverless Edge AI Gateway

export interface ProviderOAuth {
  type: "refresh_token" | "device_code" | "session_json";
  tokenEndpoint?: string;
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  accessToken?: string;
  expiresAt?: number;
  /** AES-GCM envelope persisted by SecretStorageAdapter; never exposed to callers. */
  sealed?: string;
}

export interface ProviderConnection {
  catalogId: string;
  transport: "gemini-native" | "native-bridge" | "cursor-official" | "generic-oauth";
  status: "active" | "bridge-required" | "unsupported";
  createdAt: number;
}

export type ProviderKeyStrategy = "fallback" | "round-robin";

export interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey?: string;
  /** Derived for authenticated dashboard responses; never persisted as a credential. */
  keyCount?: number;
  type: "openai" | "anthropic" | "gemini" | "custom";
  headers?: Record<string, string>;
  oauth?: ProviderOAuth;
  connection?: ProviderConnection;
  enabled: boolean;
  keyStrategy?: ProviderKeyStrategy;
  stickyCount?: number;
}

export type ComboStrategy = "fallback" | "round-robin" | "latency-first" | "ttft-first";

export interface TargetRoute {
  providerId: string;
  model: string;
  priority?: number;
  timeoutMs?: number;
}

export interface ModelCombo {
  id: string; // e.g. "free-qwen", "smart-tier", "claude-fallback"
  displayName: string;
  description?: string;
  targets: TargetRoute[];
  enabled: boolean;
  strategy?: ComboStrategy;
}

export interface ImageUrlBlock {
  type: "image_url";
  image_url: {
    url: string; // data URL "data:image/png;base64,..." or http url
    detail?: "auto" | "low" | "high";
  };
}

export interface TextBlock {
  type: "text";
  text: string;
}

export type MessageContent = string | Array<TextBlock | ImageUrlBlock | Record<string, unknown>>;

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: MessageContent;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ToolFunction {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface ToolDefinition {
  type: "function";
  function: ToolFunction;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  tools?: ToolDefinition[];
  tool_choice?: unknown;
  options?: unknown; // Often sent by Ollama/Hermes, needs sanitizing
  [key: string]: unknown;
}

export interface TelemetryLog {
  id: string;
  timestamp: number;
  model: string;
  targetProvider: string;
  targetModel: string;
  status: number;
  latencyMs: number;
  promptTokens?: number;
  completionTokens?: number;
  tokens?: number;
  error?: string;
}
