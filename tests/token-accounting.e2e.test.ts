// End-to-end token accounting verification.
// Spins up a mock OpenAI-compatible upstream, drives real requests through the
// gateway, then asserts the SQLite telemetry row carries a real input/output split.
//
// Run: bun test tests/token-accounting.e2e.test.ts
import { describe, expect, it } from "bun:test";
import { EdgeRouter } from "../src/core/router";
import { SqliteStorageAdapter } from "../src/storage/sqlite";
import type { ChatCompletionRequest, ModelCombo, Provider } from "../src/types";

const MOCK_PORT = 20998;

let mockStarted = false;
function startMockUpstream() {
  if (mockStarted) return;
  mockStarted = true;

  Bun.serve({
    port: MOCK_PORT,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/v1/models") {
        return Response.json({ object: "list", data: [{ id: "mock-model", object: "model" }] });
      }

      if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
        const body = (await req.json()) as { stream?: boolean };

        if (body.stream) {
          const encoder = new TextEncoder();
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] })}\n\n`
                )
              );
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                    usage: { prompt_tokens: 24, completion_tokens: 6, total_tokens: 30 },
                  })}\n\n`
                )
              );
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            },
          });
          return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
        }

        return Response.json({
          id: "mock-1",
          object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 24, completion_tokens: 6, total_tokens: 30 },
        });
      }

      return new Response("Not Found", { status: 404 });
    },
  });
}

async function buildRouter() {
  startMockUpstream();

  const storage = new SqliteStorageAdapter(":memory:");

  const provider: Provider = {
    id: "mock-provider",
    name: "Mock Upstream",
    baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
    apiKey: "test-key",
    type: "openai",
    enabled: true,
  };
  await storage.saveProvider(provider);

  const combo: ModelCombo = {
    id: "mock-combo",
    displayName: "Mock Combo",
    enabled: true,
    targets: [{ providerId: "mock-provider", model: "mock-model", priority: 10 }],
  };
  await storage.saveCombo(combo);

  return { router: new EdgeRouter(storage), storage };
}

describe("Token accounting end-to-end", () => {
  it("records an input/output token split on a non-streaming request", async () => {
    const { router, storage } = await buildRouter();

    const body: ChatCompletionRequest = {
      model: "mock-combo",
      messages: [{ role: "user", content: "hello" }],
    };

    const res = await router.dispatch(new Request("http://gw/v1/chat/completions", { method: "POST" }), body);
    expect(res.status).toBe(200);

    // Let the async telemetry write settle
    await Bun.sleep(120);

    const logs = await storage.getLogs({ limit: 5 });
    expect(logs.length).toBeGreaterThan(0);

    const row = logs.find((l) => l.model === "mock-combo");
    expect(row).toBeDefined();
    expect(row?.promptTokens).toBe(24);
    expect(row?.completionTokens).toBe(6);
    expect(row?.tokens).toBe(30);

    const metrics = await storage.getMetrics();
    expect(metrics.promptTokens).toBe(24);
    expect(metrics.completionTokens).toBe(6);
    expect(metrics.totalTokens).toBe(30);
  });

  it("records an input/output token split on a streaming request", async () => {
    const { router, storage } = await buildRouter();

    const body: ChatCompletionRequest = {
      model: "mock-combo",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    };

    const res = await router.dispatch(new Request("http://gw/v1/chat/completions", { method: "POST" }), body);
    expect(res.status).toBe(200);

    // Drain the stream so the usage callback fires
    const text = await new Response(res.body).text();
    expect(text).toContain("data:");

    await Bun.sleep(200);

    const logs = await storage.getLogs({ limit: 5 });
    const row = logs.find((l) => l.model === "mock-combo" && l.promptTokens === 24);
    expect(row).toBeDefined();
    expect(row?.promptTokens).toBe(24);
    expect(row?.completionTokens).toBe(6);
    expect(row?.tokens).toBe(30);

    const metrics = await storage.getMetrics();
    expect(metrics.promptTokens).toBeGreaterThanOrEqual(24);
    expect(metrics.completionTokens).toBeGreaterThanOrEqual(6);
  });
});
