import { describe, expect, it } from "bun:test";
import worker from "../src/worker";

const context = { waitUntil: (_promise: Promise<unknown>) => {} };
const env = {
  ADMIN_PASSWORD: "test-admin-password",
  MASTER_KEY: "test-master-key-material-with-at-least-thirty-two-chars",
};
const headers = { "x-admin-key": env.ADMIN_PASSWORD };
const googleAdc = {
  type: "authorized_user",
  client_id: "client-id.apps.googleusercontent.com",
  client_secret: "client-secret",
  refresh_token: "refresh-token",
  token_uri: "https://oauth2.googleapis.com/token",
};

describe("built-in connection API", () => {
  it("lists catalog entries and creates a redacted Google ADC connection", async () => {
    const catalogResponse = await worker.fetch(
      new Request("https://isoroute.test/api/connections/catalog", { headers }),
      env,
      context,
    );
    expect(catalogResponse.status).toBe(200);
    const catalog = await catalogResponse.json() as { catalog: Array<{ id: string; connected: number }> };
    expect(catalog.catalog.find((entry) => entry.id === "google-adc")?.connected).toBe(0);

    const createResponse = await worker.fetch(
      new Request("https://isoroute.test/api/connections", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          catalogId: "google-adc",
          label: "Test Workspace",
          sessionJson: JSON.stringify(googleAdc),
        }),
      }),
      env,
      context,
    );
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json() as { provider: Record<string, unknown> };
    expect(created.provider.connection).toMatchObject({ catalogId: "google-adc", transport: "gemini-native" });
    expect(created.provider.apiKey).toBeUndefined();
    expect(JSON.stringify(created.provider)).not.toContain("refresh-token");
    expect(JSON.stringify(created.provider)).not.toContain("client-secret");

    const connectionsResponse = await worker.fetch(
      new Request("https://isoroute.test/api/connections", { headers }),
      env,
      context,
    );
    const connections = await connectionsResponse.json() as { connections: Array<{ name: string }> };
    expect(connections.connections.some((entry) => entry.name === "Test Workspace")).toBe(true);
  });

  it("rejects credential imports when the worker has no master key", async () => {
    const response = await worker.fetch(
      new Request("https://isoroute.test/api/connections", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          catalogId: "google-adc",
          label: "Unprotected Workspace",
          sessionJson: JSON.stringify(googleAdc),
        }),
      }),
      { ADMIN_PASSWORD: env.ADMIN_PASSWORD },
      context,
    );

    expect(response.status).toBe(503);
    expect((await response.json() as { error: string }).error).toContain("MASTER_KEY");
  });
});
