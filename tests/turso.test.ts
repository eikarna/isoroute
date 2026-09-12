import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { TursoStorageAdapter } from "../src/storage/turso";
import type { Provider } from "../src/types";

describe("TursoStorageAdapter HTTP Pipeline", () => {
  let mockServer: any;
  let serverPort = 20888;
  let adapter: TursoStorageAdapter;
  const mockRows: Record<string, any[]> = {
    providers: [],
    combos: [],
    telemetry_logs: [],
    api_keys: [],
    route_rules: [],
  };

  beforeAll(() => {
    mockServer = Bun.serve({
      port: serverPort,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/v2/pipeline" && req.method === "POST") {
          const auth = req.headers.get("Authorization");
          if (!auth || !auth.startsWith("Bearer test-token")) {
            return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
          }

          const body = (await req.json()) as any;
          const requestList = body.requests || [];
          const results: any[] = [];

          for (const r of requestList) {
            if (r.type === "execute") {
              const sql: string = r.stmt.sql.trim();
              const args: any[] = r.stmt.args || [];

              if (sql.startsWith("CREATE TABLE") || sql.startsWith("CREATE INDEX")) {
                results.push({
                  type: "ok",
                  response: {
                    type: "execute",
                    result: { cols: [], rows: [], affected_row_count: 0 },
                  },
                });
              } else if (sql.startsWith("INSERT INTO providers")) {
                const [id, name, baseUrl, apiKey, type, headersJson, oauthJson, enabled] = args.map((a: any) => a.value);
                mockRows.providers = mockRows.providers.filter((p) => p.id !== id);
                mockRows.providers.push({
                  id,
                  name,
                  base_url: baseUrl,
                  api_key: apiKey,
                  type,
                  headers_json: headersJson,
                  oauth_json: oauthJson,
                  enabled: enabled ? 1 : 0,
                });
                results.push({
                  type: "ok",
                  response: {
                    type: "execute",
                    result: { cols: [], rows: [], affected_row_count: 1 },
                  },
                });
              } else if (sql.startsWith("SELECT * FROM providers")) {
                results.push({
                  type: "ok",
                  response: {
                    type: "execute",
                    result: {
                      cols: [
                        { name: "id" },
                        { name: "name" },
                        { name: "base_url" },
                        { name: "api_key" },
                        { name: "type" },
                        { name: "headers_json" },
                        { name: "oauth_json" },
                        { name: "enabled" },
                      ],
                      rows: mockRows.providers.map((p) => [
                        { type: "text", value: p.id },
                        { type: "text", value: p.name },
                        { type: "text", value: p.base_url },
                        p.api_key ? { type: "text", value: p.api_key } : { type: "null" },
                        { type: "text", value: p.type },
                        p.headers_json ? { type: "text", value: p.headers_json } : { type: "null" },
                        p.oauth_json ? { type: "text", value: p.oauth_json } : { type: "null" },
                        { type: "integer", value: String(p.enabled) },
                      ]),
                    },
                  },
                });
              } else {
                results.push({
                  type: "ok",
                  response: {
                    type: "execute",
                    result: { cols: [], rows: [], affected_row_count: 0 },
                  },
                });
              }
            } else if (r.type === "close") {
              results.push({
                type: "ok",
                response: { type: "close" },
              });
            }
          }

          return Response.json({ results });
        }

        return new Response("Not found", { status: 404 });
      },
    });

    adapter = new TursoStorageAdapter(`http://127.0.0.1:${serverPort}`, "test-token");
  });

  afterAll(() => {
    mockServer?.stop();
  });

  it("initializes schema via /v2/pipeline", async () => {
    await adapter.initSchema();
    expect(true).toBe(true);
  });

  it("saves and retrieves providers", async () => {
    const p: Provider = {
      id: "turso-p1",
      name: "Turso Provider",
      baseUrl: "https://api.example.com",
      type: "openai",
      enabled: true,
    };

    await adapter.saveProvider(p);
    const list = await adapter.getProviders();
    expect(list.length).toBe(1);
    expect(list[0].id).toBe("turso-p1");
    expect(list[0].name).toBe("Turso Provider");
  });
});
