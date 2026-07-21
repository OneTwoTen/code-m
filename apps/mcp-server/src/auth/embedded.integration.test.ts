import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCodeMConfig } from "../config.ts";
import { SQLiteOAuthStore } from "../storage/sqlite-oauth-store.ts";
import { openCodeMDatabase } from "../storage/sqlite.ts";
import { EmbeddedAuthorizationServer } from "./embedded.ts";

const temporaryDirectories: string[] = [];
afterEach(async () => {
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

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "codem-embedded-oauth-"));
  temporaryDirectories.push(dataDir);
  const config = loadCodeMConfig({
    CODEM_TRANSPORT: "http",
    CODEM_PUBLIC_URL: "http://localhost:3000",
    CODEM_SECRET_KEY: "this-is-a-long-random-secret-for-tests",
    CODEM_DATA_DIR: dataDir,
    CODEM_AUTH_SCOPES: "codem:read",
  });
  if (config.transport !== "http" || config.auth.provider !== "embedded") {
    throw new Error("expected embedded HTTP config");
  }
  const embeddedConfig = config as typeof config & {
    auth: Extract<typeof config.auth, { provider: "embedded" }>;
  };
  const storage = await openCodeMDatabase(config.databaseUrl, dataDir);
  const now = new Date().toISOString();
  storage.database.run(
    "INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)",
    ["user_1", "admin", "hash", "admin", now],
  );
  storage.database.run(
    "INSERT INTO oauth_clients (client_id, redirect_uris, client_name, created_at) VALUES (?, ?, ?, ?)",
    ["client_1", JSON.stringify(["http://127.0.0.1/callback"]), "Coding Agent", now],
  );
  const session = "session-token";
  storage.database.run(
    "INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
    [sha256(session), "user_1", new Date(Date.now() + 60_000).toISOString(), now],
  );
  const server = new EmbeddedAuthorizationServer({
    database: storage.database,
    config: embeddedConfig,
    store: new SQLiteOAuthStore(storage.database),
  });
  return { storage, server, session };
}

describe("embedded OAuth integration", () => {
  test("requires consent, validates CSRF, reuses grants, and rotates tokens", async () => {
    const { storage, server, session } = await fixture();
    try {
      const verifier = "verification-secret";
      const authorizationUrl = new URL("http://localhost:3000/oauth/authorize");
      authorizationUrl.search = new URLSearchParams({
        response_type: "code",
        client_id: "client_1",
        redirect_uri: "http://127.0.0.1/callback",
        resource: "http://localhost:3000/mcp",
        scope: "codem:read",
        state: "state_1",
        code_challenge_method: "S256",
        code_challenge: challenge(verifier),
      }).toString();

      const consent = await server.handle(
        new Request(authorizationUrl, { headers: { cookie: `codem_session=${session}` } }),
      );
      expect(consent?.status).toBe(200);
      const consentBody = await consent?.text();
      expect(consentBody).toContain("Authorize Coding Agent");
      const requestToken = hiddenInput(consentBody ?? "", "request_token");
      const csrfToken = hiddenInput(consentBody ?? "", "csrf_token");

      const invalidCsrf = await server.handle(
        new Request("http://localhost:3000/oauth/authorize", {
          method: "POST",
          headers: { cookie: `codem_session=${session}` },
          body: new URLSearchParams({
            decision: "allow",
            request_token: requestToken,
            csrf_token: "incorrect",
          }),
        }),
      );
      expect(invalidCsrf?.status).toBe(400);

      const allowed = await server.handle(
        new Request("http://localhost:3000/oauth/authorize", {
          method: "POST",
          headers: { cookie: `codem_session=${session}` },
          body: new URLSearchParams({
            decision: "allow",
            request_token: requestToken,
            csrf_token: csrfToken,
          }),
        }),
      );
      expect(allowed?.status).toBe(303);
      const code = new URL(allowed?.headers.get("location") ?? "").searchParams.get("code");
      expect(code).toBeTruthy();

      const tokenRequest = () =>
        new Request("http://localhost:3000/oauth/token", {
          method: "POST",
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code: code ?? "",
            client_id: "client_1",
            redirect_uri: "http://127.0.0.1/callback",
            code_verifier: verifier,
          }),
        });
      const tokenResponse = await server.handle(tokenRequest());
      expect(tokenResponse?.status).toBe(200);
      const pair = (await tokenResponse?.json()) as {
        access_token: string;
        refresh_token: string;
      };
      expect(pair.access_token).toBeTruthy();
      expect((await server.handle(tokenRequest()))?.status).toBe(400);

      const rotated = await server.handle(
        new Request("http://localhost:3000/oauth/token", {
          method: "POST",
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: pair.refresh_token,
            client_id: "client_1",
          }),
        }),
      );
      expect(rotated?.status).toBe(200);
      const rotatedPair = (await rotated?.json()) as { refresh_token: string };
      expect(rotatedPair.refresh_token).not.toBe(pair.refresh_token);

      const reusedGrant = await server.handle(
        new Request(authorizationUrl, { headers: { cookie: `codem_session=${session}` } }),
      );
      expect(reusedGrant?.status).toBe(303);
      expect(reusedGrant?.headers.get("location")).toContain("code=");
    } finally {
      storage.close();
    }
  });
});
