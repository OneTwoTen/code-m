import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunProcessRunner } from "@codem/adapters";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CODEM_APPLICATION } from "../../apps/mcp-server/src/application-metadata.ts";
import { loadCodeMConfig } from "../../apps/mcp-server/src/config.ts";
import type {
  GitHubConnectionStatus,
  GitHubRepository,
  RepositoryListInput,
  RepositoryPage,
} from "../../apps/mcp-server/src/github/github-app.ts";
import { createHttpHandler } from "../../apps/mcp-server/src/http-server.ts";
import { SQLiteWorkspaceStore } from "../../apps/mcp-server/src/storage/sqlite-workspace-store.ts";
import { openCodeMDatabase } from "../../apps/mcp-server/src/storage/sqlite.ts";
import type {
  GitCloneInput,
  GitFetchInput,
  GitTransport,
} from "../../apps/mcp-server/src/workspace/git-transport.ts";
import { RepositoryWorkspaceService } from "../../apps/mcp-server/src/workspace/repository-workspace-service.ts";

const temporaryDirectories: string[] = [];
const closeDatabase: Array<() => void> = [];
const clients: Client[] = [];
const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  for (const server of servers.splice(0)) server.stop(true);
  for (const close of closeDatabase.splice(0)) close();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function challenge(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function hiddenInput(body: string, name: string): string {
  const match = body.match(new RegExp(`name="${name}" value="([^"]+)"`));
  if (!match?.[1]) throw new Error(`missing hidden input ${name}`);
  return match[1];
}

function textContent(result: unknown): string {
  const contents = (result as { content?: unknown }).content;
  if (!Array.isArray(contents)) throw new Error("expected MCP content array");
  const content = contents[0] as { type?: unknown; text?: unknown } | undefined;
  if (content?.type !== "text" || typeof content.text !== "string") {
    throw new Error("expected MCP text content");
  }
  return content.text;
}

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

class FakeGitHubProvider {
  readonly token = "installation-token-must-not-leak";
  readonly repository: GitHubRepository = {
    fullName: "owner/private-repository",
    defaultBranch: "main",
    private: true,
    cloneUrl: "https://github.example/owner/private-repository.git",
    permissions: { pull: true, push: false },
  };

  async getConnectionStatus(): Promise<GitHubConnectionStatus> {
    return { configured: true, authenticated: true, reachable: true };
  }

  async listRepositories(_input: RepositoryListInput): Promise<RepositoryPage> {
    return {
      repositories: [
        {
          fullName: this.repository.fullName,
          defaultBranch: this.repository.defaultBranch,
          private: this.repository.private,
          ...(this.repository.permissions ? { permissions: this.repository.permissions } : {}),
        },
      ],
    };
  }

  async getRepository(fullName: string): Promise<GitHubRepository> {
    if (fullName !== this.repository.fullName) throw new Error("unexpected repository");
    return this.repository;
  }

  async withInstallationToken<T>(operation: (token: string) => Promise<T>): Promise<T> {
    return operation(this.token);
  }
}

class FakeGitTransport implements GitTransport {
  readonly cloneUrls: string[] = [];
  readonly receivedPasswords: string[] = [];

  async clone(input: GitCloneInput): Promise<void> {
    this.cloneUrls.push(input.cloneUrl);
    this.receivedPasswords.push(input.credential.password);
    await mkdir(join(input.checkoutPath, ".git"), { recursive: true });
    await writeFile(join(input.checkoutPath, "README.md"), "repository workspace e2e\n");
    await writeFile(
      join(input.checkoutPath, ".git", "config"),
      `[remote "origin"]\n\turl = ${input.cloneUrl}\n`,
    );
  }

  async fetch(_input: GitFetchInput): Promise<void> {}

  async isDirty(): Promise<boolean> {
    return false;
  }

  async checkoutRef(): Promise<string> {
    return "abc123def456";
  }
}

async function embeddedAccessToken(
  publicUrl: URL,
  mcpUrl: URL,
  database: Awaited<ReturnType<typeof openCodeMDatabase>>["database"],
): Promise<string> {
  const now = new Date().toISOString();
  const session = "http-e2e-session";
  database.run(
    "INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)",
    ["user_http_e2e", "http-e2e-admin", "hash", "admin", now],
  );
  database.run(
    "INSERT INTO oauth_clients (client_id, redirect_uris, client_name, created_at) VALUES (?, ?, ?, ?)",
    ["client_http_e2e", JSON.stringify(["http://127.0.0.1/callback"]), "HTTP E2E Client", now],
  );
  database.run("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)", [
    sha256(session),
    "user_http_e2e",
    new Date(Date.now() + 60_000).toISOString(),
    now,
  ]);

  const verifier = "http-e2e-verification-secret";
  const authorizationUrl = new URL("/oauth/authorize", publicUrl);
  authorizationUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: "client_http_e2e",
    redirect_uri: "http://127.0.0.1/callback",
    resource: mcpUrl.href,
    scope: "codem:read codem:workspace",
    state: "http-e2e-state",
    code_challenge_method: "S256",
    code_challenge: challenge(verifier),
  }).toString();

  const consent = await fetch(authorizationUrl, {
    headers: { cookie: `codem_session=${session}` },
    redirect: "manual",
  });
  expect(consent.status).toBe(200);
  const consentBody = await consent.text();
  const requestToken = hiddenInput(consentBody, "request_token");
  const csrfToken = hiddenInput(consentBody, "csrf_token");

  const allowed = await fetch(new URL("/oauth/authorize", publicUrl), {
    method: "POST",
    headers: {
      cookie: `codem_session=${session}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      decision: "allow",
      request_token: requestToken,
      csrf_token: csrfToken,
    }),
    redirect: "manual",
  });
  expect(allowed.status).toBe(303);
  const code = new URL(allowed.headers.get("location") ?? "").searchParams.get("code");
  if (!code) throw new Error("expected authorization code");

  const tokenResponse = await fetch(new URL("/oauth/token", publicUrl), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: "client_http_e2e",
      redirect_uri: "http://127.0.0.1/callback",
      code_verifier: verifier,
    }),
  });
  expect(tokenResponse.status).toBe(200);
  const token = (await tokenResponse.json()) as { access_token: string };
  return token.access_token;
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

  test("authenticates, lists a repository, opens it, and reads README by workspaceId", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "codem-http-workspace-e2e-"));
    temporaryDirectories.push(dataDir);

    let handler: (request: Request) => Promise<Response> = async () =>
      new Response("server not initialized", { status: 503 });
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => handler(request),
    });
    servers.push(server);

    const publicUrl = new URL(`http://127.0.0.1:${server.port}`);
    const config = loadCodeMConfig({
      CODEM_TRANSPORT: "http",
      CODEM_PUBLIC_URL: publicUrl.href,
      CODEM_SECRET_KEY: "this-is-a-long-random-secret-for-tests",
      CODEM_DATA_DIR: dataDir,
    });
    if (config.transport !== "http") throw new Error("expected HTTP config");

    const storage = await openCodeMDatabase(config.databaseUrl, dataDir);
    closeDatabase.push(storage.close);
    const github = new FakeGitHubProvider();
    const git = new FakeGitTransport();
    const repositoryWorkspaces = new RepositoryWorkspaceService({
      workspacesDir: config.workspacesDir,
      store: new SQLiteWorkspaceStore(storage.database),
      github,
      git,
      createId: () => "ws_http_e2e",
    });
    handler = createHttpHandler(config, {
      workspaceRoot: process.cwd(),
      processRunner: new BunProcessRunner(),
      database: storage.database,
      github,
      repositoryWorkspaces,
    });

    const accessToken = await embeddedAccessToken(
      config.publicUrl,
      config.mcpUrl,
      storage.database,
    );
    const transport = new StreamableHTTPClientTransport(config.mcpUrl, {
      requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
    });
    const client = new Client({ name: "codem-http-e2e", version: "1.0.0" });
    clients.push(client);
    await client.connect(transport as Parameters<Client["connect"]>[0]);

    const listed = await client.callTool({
      name: "repository.list",
      arguments: { limit: 10 },
    });
    expect(listed.isError).not.toBe(true);
    const listedText = textContent(listed);
    expect(listedText).toContain(github.repository.fullName);
    expect(listedText).not.toContain(github.token);
    expect(listedText).not.toContain(github.repository.cloneUrl);

    const openedResult = await client.callTool({
      name: "workspace.open_repository",
      arguments: { repository: github.repository.fullName },
    });
    expect(openedResult.isError).not.toBe(true);
    const openedText = textContent(openedResult);
    const opened = JSON.parse(openedText) as { workspaceId: string; status: string };
    expect(opened).toMatchObject({ workspaceId: "ws_http_e2e", status: "ready" });
    expect(openedText).not.toContain(github.token);

    const read = await client.callTool({
      name: "workspace.read_file",
      arguments: { workspaceId: opened.workspaceId, path: "README.md" },
    });
    expect(read.isError).not.toBe(true);
    expect(textContent(read)).toContain("repository workspace e2e");

    const workspaceRows = storage.database.query("SELECT * FROM workspaces").all();
    expect(JSON.stringify(workspaceRows)).not.toContain(github.token);
    expect(git.receivedPasswords).toEqual([github.token]);
    expect(git.cloneUrls).toEqual([github.repository.cloneUrl]);
    const gitConfig = await readFile(
      join(config.workspacesDir, opened.workspaceId, "repository", ".git", "config"),
      "utf8",
    );
    expect(gitConfig).toContain(github.repository.cloneUrl);
    expect(gitConfig).not.toContain(github.token);
  });
});
