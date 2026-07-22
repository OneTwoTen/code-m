import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunProcessRunner } from "@codem/adapters";
import { CODEM_APPLICATION } from "../../apps/mcp-server/src/application-metadata.ts";
import { loadCodeMConfig } from "../../apps/mcp-server/src/config.ts";
import { createHttpHandler } from "../../apps/mcp-server/src/http-server.ts";
import { openCodeMDatabase } from "../../apps/mcp-server/src/storage/sqlite.ts";

const temporaryDirectories: string[] = [];
const closeDatabase: Array<() => void> = [];

afterEach(async () => {
  for (const close of closeDatabase.splice(0)) close();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "codem-http-e2e-"));
  temporaryDirectories.push(dataDir);
  const config = loadCodeMConfig({
    CODEM_TRANSPORT: "http",
    CODEM_PUBLIC_URL: "http://localhost:3000",
    CODEM_SECRET_KEY: "this-is-a-long-random-secret-for-tests",
    CODEM_DATA_DIR: dataDir,
  });
  if (config.transport !== "http") throw new Error("expected HTTP config");
  const storage = await openCodeMDatabase(config.databaseUrl, dataDir);
  closeDatabase.push(storage.close);
  const handler = createHttpHandler(config, {
    workspaceRoot: process.cwd(),
    processRunner: new BunProcessRunner(),
    database: storage.database,
  });
  const request = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("host", config.publicUrl.host);
    return new Request(new URL(path, config.publicUrl), { ...init, headers });
  };
  return { config, handler, request };
}

describe("HTTP production boundary", () => {
  test("reports canonical health and OAuth metadata", async () => {
    const { config, handler, request } = await fixture();

    const health = await handler(request("/health"));
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      status: "ok",
      application: CODEM_APPLICATION,
      transport: "http",
      database: "ready",
    });

    const resourceMetadata = await handler(request("/.well-known/oauth-protected-resource"));
    expect(resourceMetadata.status).toBe(200);
    expect(await resourceMetadata.json()).toMatchObject({
      resource: config.mcpUrl.href,
      authorization_servers: [config.publicUrl.href.replace(/\/$/, "")],
      scopes_supported: ["codem:read", "codem:workspace"],
      bearer_methods_supported: ["header"],
    });

    const authorizationMetadata = await handler(request("/.well-known/oauth-authorization-server"));
    expect(authorizationMetadata.status).toBe(200);
    expect(await authorizationMetadata.json()).toMatchObject({
      issuer: config.publicUrl.href.replace(/\/$/, ""),
      scopes_supported: ["codem:read", "codem:workspace"],
    });
  });

  test("challenges unauthenticated MCP requests", async () => {
    const { config, handler, request } = await fixture();
    const response = await handler(
      request("/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "http-test", version: "1.0.0" },
          },
        }),
      }),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${new URL("/.well-known/oauth-protected-resource", config.publicUrl).href}"`,
    );
  });

  test("enforces host, redirect, and embedded execute-scope policies", async () => {
    const { config, handler, request } = await fixture();

    const invalidHost = await handler(
      new Request(new URL("/health", config.publicUrl), { headers: { host: "attacker.example" } }),
    );
    expect(invalidHost.status).toBe(403);

    const invalidRegistration = await handler(
      request("/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: ["http://client.example/callback"] }),
      }),
    );
    expect(invalidRegistration.status).toBe(400);

    const registration = await handler(
      request("/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          redirect_uris: ["http://127.0.0.1/callback"],
          client_name: "HTTP test client",
        }),
      }),
    );
    expect(registration.status).toBe(201);
    const client = (await registration.json()) as { client_id: string };

    const authorize = new URL("/oauth/authorize", config.publicUrl);
    authorize.search = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: "http://127.0.0.1/callback",
      resource: config.mcpUrl.href,
      scope: "codem:execute",
      code_challenge_method: "S256",
      code_challenge: "challenge",
    }).toString();
    const executeScope = await handler(
      new Request(authorize, { headers: { host: config.publicUrl.host } }),
    );
    expect(executeScope.status).toBe(400);
    expect(await executeScope.json()).toMatchObject({ error: "invalid_scope" });
  });
});
