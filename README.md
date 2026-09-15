# ⚡ IsoRoute

> **High-performance, isomorphic AI Gateway & force router** built on standard Web APIs (WinterCG compliant).  
> Zero npm dependencies on the core path. Deploys seamlessly to **Bun**, **Cloudflare Workers**, and **Vercel Edge**.

---

## Key Features

- **🌐 100% Isomorphic Edge Architecture:** Built strictly using Standard Web APIs (`fetch`, `Request`, `Response`, `TransformStream`, `Web Crypto`). Runs without code modifications on Bun, Cloudflare Workers, and Vercel Edge.
- **⚡ ReDoS-Safe Force Routing:** Rewrite and route incoming model calls via wildcard & regex matching (e.g. `claude-*-opus` ➔ `gemini-$1-latest`, `*high` ➔ `deepseek-v4.1-flash`) with linear time complexity and zero catastrophic backtracking risks.
- **🔑 Consumer API Key Billing & Quotas:**
  - Expiration policies: `1d`, `7d`, `30d`, `90d`, `1y`, or `never`.
  - Granular limits: Max requests, max total tokens, max input tokens, and max output tokens.
  - Guard policies: Required headers verification, body signature check, and allowed models whitelist.
- **🔄 Protocol Translation Adapters:**
  - **OpenAI ➔ Google Gemini Native (`generateContent`):** Real-time translation of messages, system instructions, multimodal inputs, and streaming SSE tokens.
  - **OpenAI ➔ Anthropic Messages Native (`/v1/messages`):** Real-time mapping of tool definitions, tool calls, and delta events.
- **🗄️ Pluggable Storage Adapters:**
  - **Local SQLite:** Native zero-overhead `bun:sqlite` with WAL mode.
  - **Cloudflare D1:** Distributed serverless SQL database for global edge deployments.
  - **Turso (libSQL):** Pure HTTP v2 pipeline adapter for high-density deployments (>25 Million writes/month).
  - **In-Memory:** Stateless adapter for ephemeral test environments and cold-start resilience.
- **🖥️ Tactile Developer Console:**
  - Single-file pre-compiled Svelte 5 dashboard (`~105KB`, zero external assets).
  - Sub-millisecond live telemetry push via Server-Sent Events (`/api/live`).
  - Strict anti-AI-slop design: dark palette (`#09090b`), tabular monospace numerals, no bloated cards.

---

## Quickstart (Local Development with Bun)

```bash
# Clone the repository
git clone https://github.com/eikarna/isoroute.git
cd isoroute

# Install dependencies (Bun only)
bun install

# Run tests (57 tests)
bun test

# Start the gateway server (Port 20129)
bun run start
```

Visit the dashboard at `http://localhost:20129/admin/dashboard` (Default Password: `123456`).

---

## Deployment Targets

### 1. Cloudflare Workers (Recommended for High Scale)

Deploy globally with Cloudflare D1 or Turso database:

```bash
# Deploy to Cloudflare Workers
bunx wrangler deploy
```

Configure environment variables in Cloudflare dashboard or `wrangler.jsonc`:
- `ADMIN_PASSWORD`: Required production administrative password. There is no production default.
- `MASTER_KEY`: Required for encrypted upstream API keys and provider connection credentials. Use a random value of at least 32 characters and keep it stable.
- `TURSO_DATABASE_URL`: `libsql://<your-db>.turso.io` *(optional, for high write limits)*
- `TURSO_AUTH_TOKEN`: `<your-turso-token>`

### 2. Vercel Edge Runtime

Push to GitHub and import into Vercel. `vercel.json` and `api/index.ts` are pre-configured for instant zero-config edge deployment. Set `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` in Vercel project settings for persistent state across edge isolates.

---

## Force Routing Examples

| Match Pattern | Target Rewrite | Description |
| :--- | :--- | :--- |
| `claude-*-opus` | `gemini-$1-latest` | Preserves model sub-version while routing to Gemini |
| `claude*sonnet` | `free-fast` | Intercepts all Sonnet calls to fast local tier |
| `*high` | `deepseek-v4.1-flash` | Routes reasoning models to DeepSeek |
| `gpt-4o*` | `smart-tier` | Fallback routing to composite smart combo |

---

## License

MIT © [Nix Seymour](https://github.com/eikarna)
