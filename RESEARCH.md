# Architectural Research: Agnostic Provider & Unified Credential Store for Serverless AI Gateways

**Author:** Nix Seymour & Core Team  
**System:** EdgeRouter (Isomorphic Serverless AI Gateway)  
**Date:** September 2026  
**Status:** Approved Architectural Blueprint  

---

## 1. Executive Summary & The "Release Treadmill" Problem

Modern open-source AI proxies and routers (e.g., 9Router, OmniRoute, OneAPI, LiteLLM) face an architectural trap: **The Static Provider Release Treadmill**.

### The Symptom
Every time a new AI inference vendor launches (e.g., DeepSeek, Moonshot/Kimi, MiniMax, Groq, Hyperbolic, Cerebras, SambaNova, Novita) or an existing vendor tweaks their authentication/URL format, the gateway maintainer must:
1. Hardcode a new provider identifier (`provider: "xiaomi-mimo"`).
2. Hardcode a new logo, card component, and form fields in the frontend.
3. Write bespoke token-refresh or request-translation logic.
4. Cut a new version release and require users to upgrade their gateway daemon.

### The Root Cause
These systems couple **Provider Identity** (branding/logos), **Protocol Translation** (wire format), and **Credential Storage** (keys/cookies/OAuth) into tightly bound monolith classes.

In reality:
* **>95% of AI providers use the OpenAI Chat Completions REST wire format** (`/v1/chat/completions` with SSE delta streams).
* **Only 3 major non-standard protocols dominate frontier AI**:
  1. Google Gemini Native (`generateContent` & `streamGenerateContent`).
  2. Anthropic Messages Native (`/v1/messages` with event stream).
  3. OpenAI Compatible (the de facto lingua franca: DeepSeek, Qwen, Mistral, Groq, Perplexity, OpenRouter, etc.).
* **Credential mechanisms reduce to exactly 4 primitives**:
  1. Static Header Token (Bearer, API-Key header, query parameter).
  2. Multi-Key Round-Robin Pool with Circuit-Breaker Cooldown.
  3. Raw Physical Session Blob (JSON containing client secrets, refresh tokens, and checksums).
  4. Web-Based Session (Cookies, CSRF tokens, custom browser origin headers).

If we design an **Agnostic Declarative Engine**, users can connect *any* provider—past, present, or future—without waiting for a software update.

---

## 2. Taxonomy of AI Upstream Credentials

| Credential Archetype | Examples | Ingestion Wire Format | Edge Runtime Execution Strategy |
| :--- | :--- | :--- | :--- |
| **Type A: Static Token Pool** | OpenAI, DeepSeek, Groq, OpenRouter, Google Studio Key | Single string or comma-separated string (`sk-1, sk-2`) | Round-robin index pointer. If HTTP 429/503 is returned, tag key timestamp with a 180s cooldown window and route to next healthy key. |
| **Type B: JIT OAuth2 / OIDC Refresh** | Google Vertex, Azure OpenAI, HuggingFace Pro, Antigravity | JSON containing `refresh_token`, `client_id`, `client_secret`, `token_endpoint` | **Lazy Pre-Flight**: Check if `Date.now() > expiresAt - 300000` (5-min lead). If expired, fire `fetch()` to `token_endpoint` using standard Web API, store updated access token in SQLite/D1, then dispatch request. |
| **Type C: Physical CLI Session Blobs** | Kiro, Cursor (`storage.json`), Codex (`auth.json`), Google ADC | Raw structured JSON file copy-pasted directly from user's `~/.config/` | **Zero-Config Heuristic Parser**: Schema detector recognizes signature keys (`macMachineId`, `refresh_token`, `account_id`) and generates the corresponding request headers dynamically. |
| **Type D: Web-Session & Cookie Injection** | Web-based internal APIs, Cloudflare Turnstile proxied endpoints | Raw Cookie header string or JSON array of cookies (`name=value; ...`) | Injected verbatim into request headers alongside standard browser fingerprint overrides (`User-Agent`, `Origin`, `Referer`, `Sec-Fetch-Site`). |

---

## 3. The Core Architecture: Declarative Provider Blueprint

Instead of writing custom TypeScript classes for every service, each provider is defined by a declarative **WinterCG-compliant schema**:

```typescript
export interface AgnosticProviderSpec {
  id: string;                      // Unique slug: e.g. "my-deepseek-enterprise"
  name: string;                    // Human display name
  baseUrl: string;                 // Upstream base: "https://api.deepseek.com"
  protocol: "openai" | "gemini" | "anthropic"; // Native wire protocol adapter
  
  // Dynamic Authentication Specification
  auth: {
    type: "bearer" | "header" | "query" | "oauth2" | "cookie";
    headerName?: string;           // Default: "Authorization"
    headerTemplate?: string;       // Default: "Bearer {{token}}"
    paramName?: string;            // If type="query", e.g. "key"
    
    // Multi-key / Token Pool
    pool?: {
      keys: string[];              // Decrypted token pool
      strategy: "round_robin" | "random" | "priority";
      cooldownMs: number;          // Default 180,000 ms (3 minutes)
    };
    
    // Automated Lazy OAuth Refresh (Standard RFC 6749)
    oauth?: {
      tokenUrl: string;
      clientId: string;
      clientSecret?: string;
      refreshToken: string;
      accessToken?: string;
      expiresAt?: number;
      tokenPath?: string;          // JSON pointer to access token, e.g. "access_token"
      expiresInPath?: string;      // JSON pointer to expiry, e.g. "expires_in"
    };
    
    // Cookie / Web Headers
    cookie?: string;
    extraHeaders?: Record<string, string>;
  };
  
  // Upstream Sanitizer & Workarounds (Zero-Code Parameter Stripping)
  sanitizer?: {
    stripFields?: string[];        // e.g. ["options", "thinking", "tools"]
    maxTokensField?: string;       // Some upstreams reject max_tokens and want max_completion_tokens
    emptyToolsBehavior?: "strip" | "error" | "passthrough";
  };
  
  enabled: boolean;
}
```

---

## 4. Universal "Drop-In" Credential Auto-Detector

Beginners and developers should not need to navigate 20 dropdown menus to figure out whether their credential is a Bearer key, an ADC JSON, or an OAuth session.

### The Heuristic Ingestion Algorithm
The frontend provides a single, high-density textarea: **"Credential Input"**. The gateway runs an instant client-side inspection:

```text
                  [User Pastes Text / JSON]
                              │
               Is it valid JSON (begins with '{')?
                     ┌────────┴────────┐
                    YES                NO
                     │                 │
    Does it contain "client_id" &      Does it contain "Cookie:" or "session="?
    "refresh_token" or "private_key"?        ┌────────┴────────┐
             ┌───────┴───────┐              YES                NO
            YES              NO              │                 │
             │               │         Type: COOKIE       Does it contain comma / newline?
       Type: OAUTH     Type: JSON_BLOB (Inject as header)        ┌───────┴───────┐
       (Extract token  (Dynamic header                          YES              NO
        parameters)     mapping)                                 │               │
                                                           Type: KEY_POOL   Type: SINGLE_KEY
                                                           (Round-robin)    (Bearer/Direct)
```

### Supported Auto-Detection Signatures
1. **Plain Key:** `sk-...`, `AIzaSy...`, or any alphanumeric string `> 16 chars` -> `auth.type = "bearer"`.
2. **Key Pool:** Multiple lines or strings delimited by `,` or `;` -> `auth.type = "bearer"`, populate `auth.pool.keys`.
3. **Google ADC / Service Account:** JSON with `"type": "service_account"` or `"private_key"` -> Auto-maps to Google JWT / OAuth lifecycle.
4. **Physical CLI Session:** JSON with `"refresh_token"` and `"token_uri"` -> Auto-maps to `auth.oauth`.
5. **Cookie Header:** Contains `session=`, `__cf_bm=`, `cf_clearance=` -> Auto-maps to `auth.type = "cookie"`.

---

## 5. UI/UX Paradigm: The Unified Credential Vault

### Why 9Router / OmniRoute Cards Fail:
* 50 static cards create visual clutter.
* 90% of the cards remain empty/unused for any single user.
* Adding an unlisted provider feels like a second-class experience ("Generic/Custom Provider" modal).

### The Tactile Alternative: Unified Vault Table
Instead of logo cards, the interface adopts a **Linear / Cloudflare Zero-Trust Vault** design:
1. **Single Responsive Table (Desktop) / Compact Feed (Mobile):**
   * Columns: `PROVIDER / ALIAS` | `PROTOCOL` | `CREDENTIAL TYPE` | `KEY POOL & HEALTH` | `ACTIONS`
2. **Status Badges:**
   * `4 / 4 Active` (Emerald)
   * `1 in Cooldown (142s left)` (Amber)
   * `Token Expired` (Red)
3. **Drawer Form with Live Model Ping:**
   * User enters Base URL + Credential.
   * A "Test Connection" button fires `GET /models` or a 1-token test prompt.
   * Real latency and model count are displayed immediately before saving.

---

## 6. Security & Storage Architecture on Edge Runtimes

Because EdgeRouter must run seamlessly on **Bun Native** and **Cloudflare Workers (Edge)**, credential storage must adhere to strict constraints:

### A. At-Rest Encryption (Web Crypto API)
* Sensitive fields (`apiKey`, `oauth_json`, `cookie`) are encrypted using **AES-GCM-256**.
* The master key is derived from `ENCRYPTION_SECRET` via **PBKDF2 / HKDF** using Web Crypto (`crypto.subtle`), ensuring 100% compatibility with Cloudflare Workers without Node.js `crypto` dependencies.

### B. In-Memory Decryption Cache
* Decrypted credentials remain ephemeral in memory during the request lifecycle.
* Never written to unencrypted logs or returned in public `/api/*` endpoints (masked as `sk-...abcd`).

### C. Zero-Daemon JIT Token Refresh
* No long-running cron daemons required.
* If a token is within 5 minutes of expiration, the inbound request itself triggers the lazy refresh asynchronously, updates SQLite/D1, and proceeds with inference.

---

## 7. Implementation Roadmap & Prototype Blueprint

```text
Phase 1: Declarative Schema & Universal Router
├── Define AgnosticProviderSpec TypeScript interface
├── Update SqliteStorageAdapter & D1StorageAdapter with JSON-backed spec
└── Implement RequestSanitizer with declarative field stripping

Phase 2: Universal Credential Ingestor & Auto-Detector
├── Build detectCredentialType(input: string) heuristic parser
├── Implement RFC 6749 standard OAuth2 Lazy Refresher
└── Add Cookie & Multi-Key Pool support to core dispatcher

Phase 3: Tactile Vault UI
├── Replace static form with Unified Credential Vault table
├── Add client-side Credential Auto-Detect preview box
└── Realtime upstream connectivity & model probe before save
```

This architecture ensures EdgeRouter never requires a software release just to support a new AI vendor.
