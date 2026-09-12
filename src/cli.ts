#!/usr/bin/env bun
// EdgeRouter Companion CLI (Zero Dependency)
import { readFileSync, existsSync } from "fs";

const GATEWAY_URL = process.env.GATEWAY_URL || "http://127.0.0.1:20129";
const args = process.argv.slice(2);
const command = args[0];

async function main() {
  if (!command || command === "help" || command === "--help") {
    console.log(`
⚡ EdgeRouter CLI — Serverless AI Gateway Controller

Usage:
  bun run src/cli.ts <command> [arguments]

Commands:
  status                     View live gateway metrics and active routes
  combos                     List all model combos and fallback cascade chains
  import <provider> <file>   Import local CLI session JSON (Kiro, Codex, Antigravity)
  test <model> [prompt]      Send quick test request to verify routing
  health                     Ping gateway server

Options:
  GATEWAY_URL                Override target router URL (default: http://127.0.0.1:20129)
    `);
    process.exit(0);
  }

  if (command === "status" || command === "health") {
    try {
      const res = await fetch(`${GATEWAY_URL}/api/status`);
      if (!res.ok) throw new Error(`Gateway returned ${res.status}`);
      const data = await res.json() as any;
      console.log(`\n⚡ EdgeRouter Status (${GATEWAY_URL}):`);
      console.log(`- Status:         ${data.status}`);
      console.log(`- Total Requests: ${data.metrics?.totalRequests ?? 0}`);
      console.log(`- Total Tokens:   ${(data.metrics?.totalTokens ?? 0).toLocaleString()}`);
      console.log(`- Recent Logs:    ${data.logs?.length ?? 0} events\n`);
    } catch (err) {
      console.error(`✗ Failed to connect to gateway at ${GATEWAY_URL}:`, err instanceof Error ? err.message : err);
      process.exit(1);
    }
  } else if (command === "combos") {
    try {
      const res = await fetch(`${GATEWAY_URL}/api/combos`);
      const data = await res.json() as any;
      console.log(`\n⚡ Active Model Combos (${data.combos?.length ?? 0}):\n`);
      for (const c of data.combos || []) {
        console.log(`[${c.id}] ${c.displayName}`);
        for (const [idx, t] of (c.targets || []).entries()) {
          console.log(`  ${idx + 1}. Provider: ${t.providerId} ➔ Model: ${t.model} (Priority: ${t.priority ?? 0})`);
        }
        console.log("");
      }
    } catch (err) {
      console.error("✗ Failed to list combos:", err);
      process.exit(1);
    }
  } else if (command === "import") {
    const providerId = args[1];
    const filePath = args[2];

    if (!providerId || !filePath) {
      console.error("Usage: bun run src/cli.ts import <provider-id> <path-to-json>");
      process.exit(1);
    }

    if (!existsSync(filePath)) {
      console.error(`✗ File not found: ${filePath}`);
      process.exit(1);
    }

    const sessionJson = readFileSync(filePath, "utf-8");
    console.log(`Importing session for '${providerId}' from ${filePath}...`);

    try {
      const res = await fetch(`${GATEWAY_URL}/api/oauth/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId, sessionJson }),
      });

      const data = await res.json() as any;
      if (res.ok) {
        console.log(`✓ ${data.message || "Session imported successfully!"}`);
      } else {
        console.error(`✗ Import failed: ${data.error}`);
        process.exit(1);
      }
    } catch (err) {
      console.error("✗ Request failed:", err);
      process.exit(1);
    }
  } else if (command === "test") {
    const model = args[1] || "free-fast";
    const prompt = args[2] || "Ping test from EdgeRouter CLI";

    console.log(`\nSending prompt to '${model}': "${prompt}"...`);
    const start = Date.now();

    try {
      const res = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          max_tokens: 30,
        }),
      });

      const latency = Date.now() - start;
      const text = await res.text();

      console.log(`\nHTTP Status: ${res.status} (${latency}ms)`);
      try {
        const json = JSON.parse(text);
        console.log("Response:", json.choices?.[0]?.message?.content || json);
        if (json.usage) console.log("Usage:", json.usage);
      } catch {
        console.log("Raw Response:\n", text);
      }
      console.log("");
    } catch (err) {
      console.error("✗ Test failed:", err);
      process.exit(1);
    }
  } else {
    console.error(`Unknown command: ${command}. Run 'bun run src/cli.ts --help' for usage.`);
    process.exit(1);
  }
}

main();
