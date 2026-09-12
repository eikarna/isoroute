import { describe, expect, it } from "bun:test";
import { ProviderProbe } from "../src/core/probe";

describe("ProviderProbe", () => {
  it("probes healthy mock server and returns model count and latency", async () => {
    // Spin up lightweight mock
    const server = Bun.serve({
      port: 20997,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/v1/models") {
          return Response.json({
            data: [{ id: "model-1" }, { id: "model-2" }, { id: "model-3" }],
          });
        }
        return new Response("Not found", { status: 404 });
      },
    });

    const res = await ProviderProbe.probe({
      baseUrl: "http://127.0.0.1:20997",
      apiKey: "test-key",
      type: "openai",
    });

    expect(res.valid).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.modelCount).toBe(3);
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);

    server.stop();
  });

  it("handles 401 unauthorized / invalid key gracefully", async () => {
    const server = Bun.serve({
      port: 20996,
      hostname: "127.0.0.1",
      fetch() {
        return Response.json({ error: { message: "Invalid API key" } }, { status: 401 });
      },
    });

    const res = await ProviderProbe.probe({
      baseUrl: "http://127.0.0.1:20996",
      apiKey: "bad-key",
      type: "openai",
    });

    expect(res.valid).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.error).toContain("Invalid API key");

    server.stop();
  });

  it("handles network unreachable gracefully", async () => {
    const res = await ProviderProbe.probe({
      baseUrl: "http://127.0.0.1:19999", // dead port
      apiKey: "key",
      type: "openai",
    });

    expect(res.valid).toBe(false);
    expect(res.error).toBeDefined();
  });
});
