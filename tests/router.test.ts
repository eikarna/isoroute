import { describe, expect, it, mock } from "bun:test";
import { EdgeRouter } from "../src/core/router";
import { MemoryStorageAdapter } from "../src/storage";
import type { ChatCompletionRequest, ModelCombo, Provider } from "../src/types";

describe("EdgeRouter Cascading Failover", () => {
  it("cascades from failing target (503) to healthy backup target (200)", async () => {
    // Mock global fetch to simulate target 1 failing (503) and target 2 succeeding (200)
    const originalFetch = globalThis.fetch;

    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();
      if (urlStr.includes("flaky-provider")) {
        return new Response("Service Unavailable", { status: 503 });
      }
      if (urlStr.includes("backup-provider")) {
        return Response.json({
          id: "chatcmpl-backup",
          object: "chat.completion",
          created: 1234567890,
          model: "backup-model",
          choices: [{ index: 0, message: { role: "assistant", content: "Backup success!" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        });
      }
      return new Response("Not Found", { status: 404 });
    }) as any;

    const providers: Provider[] = [
      { id: "flaky", name: "Flaky", baseUrl: "https://flaky-provider.com", type: "openai", enabled: true },
      { id: "backup", name: "Backup", baseUrl: "https://backup-provider.com", type: "openai", enabled: true },
    ];

    const combos: ModelCombo[] = [
      {
        id: "resilient-combo",
        displayName: "Resilient Combo",
        enabled: true,
        targets: [
          { providerId: "flaky", model: "model-a", priority: 10 },
          { providerId: "backup", model: "model-b", priority: 5 },
        ],
      },
    ];

    const storage = new MemoryStorageAdapter({ providers, combos });
    const router = new EdgeRouter(storage);

    const req = new Request("http://localhost/v1/chat/completions", { method: "POST" });
    const body: ChatCompletionRequest = {
      model: "resilient-combo",
      messages: [{ role: "user", content: "hello" }],
    };

    const res = await router.dispatch(req, body);
    expect(res.status).toBe(200);

    const data = await res.json() as any;
    expect(data.choices[0].message.content).toBe("Backup success!");

    // Restore fetch
    globalThis.fetch = originalFetch;
  });
});
