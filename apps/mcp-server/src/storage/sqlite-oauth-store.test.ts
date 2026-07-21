import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteOAuthStore } from "./sqlite-oauth-store.ts";
import { openCodeMDatabase } from "./sqlite.ts";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "codem-oauth-store-"));
  temporaryDirectories.push(dataDir);
  const storage = await openCodeMDatabase(`file:${join(dataDir, "codem.sqlite")}`, dataDir);
  storage.database.run(
    "INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)",
    ["user_1", "admin", "hash", "admin", new Date().toISOString()],
  );
  storage.database.run(
    "INSERT INTO oauth_clients (client_id, redirect_uris, client_name, created_at) VALUES (?, ?, ?, ?)",
    ["client_1", JSON.stringify(["https://client.example/callback"]), "Test client", new Date().toISOString()],
  );
  return { storage, store: new SQLiteOAuthStore(storage.database) };
}

describe("SQLiteOAuthStore", () => {
  test("persists grants and consumes pending authorization requests once", async () => {
    const { storage, store } = await fixture();
    try {
      store.saveGrant("user_1", "client_1", "https://codem.example/mcp", ["codem:read"]);
      expect(
        store.hasGrant("user_1", "client_1", "https://codem.example/mcp", ["codem:read"]),
      ).toBe(true);
      expect(
        store.hasGrant("user_1", "client_1", "https://codem.example/mcp", ["codem:execute"]),
      ).toBe(false);

      const tokens = store.createAuthorizationRequest({
        sessionHash: "session_hash",
        clientId: "client_1",
        userId: "user_1",
        redirectUri: "https://client.example/callback",
        resource: "https://codem.example/mcp",
        scopes: ["codem:read"],
        state: "state_1",
        codeChallenge: "challenge",
        expiresAt: new Date(Date.now() + 60_000),
      });

      const consumed = store.consumeAuthorizationRequest(
        tokens.requestToken,
        tokens.csrfToken,
        "session_hash",
        new Date(),
      );
      expect(consumed?.state).toBe("state_1");
      expect(
        store.consumeAuthorizationRequest(
          tokens.requestToken,
          tokens.csrfToken,
          "session_hash",
          new Date(),
        ),
      ).toBeUndefined();
    } finally {
      storage.close();
    }
  });

  test("consumes an authorization code once and rotates a refresh token once", async () => {
    const { storage, store } = await fixture();
    try {
      const code = store.createAuthorizationCode({
        clientId: "client_1",
        userId: "user_1",
        redirectUri: "https://client.example/callback",
        resource: "https://codem.example/mcp",
        scopes: ["codem:read"],
        codeChallenge: "challenge",
        expiresAt: new Date(Date.now() + 60_000),
      });

      const first = store.exchangeAuthorizationCode({
        code,
        clientId: "client_1",
        redirectUri: "https://client.example/callback",
        codeChallenge: "challenge",
        now: new Date(),
      });
      expect(first?.accessToken).toBeTruthy();
      expect(
        store.exchangeAuthorizationCode({
          code,
          clientId: "client_1",
          redirectUri: "https://client.example/callback",
          codeChallenge: "challenge",
          now: new Date(),
        }),
      ).toBeUndefined();

      if (!first) throw new Error("expected token pair");
      const rotated = store.rotateRefreshToken({
        refreshToken: first.refreshToken,
        clientId: "client_1",
        now: new Date(),
      });
      expect(rotated?.refreshToken).not.toBe(first.refreshToken);
      expect(
        store.rotateRefreshToken({
          refreshToken: first.refreshToken,
          clientId: "client_1",
          now: new Date(),
        }),
      ).toBeUndefined();
    } finally {
      storage.close();
    }
  });
});
