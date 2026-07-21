import { createHash, randomBytes } from "node:crypto";
import type { Database } from "bun:sqlite";
import type {
  AuthorizationCodeExchangeInput,
  AuthorizationCodeInput,
  AuthorizationRequestInput,
  AuthorizationRequestTokens,
  OAuthStore,
  PendingAuthorizationRequest,
  RefreshTokenExchangeInput,
  TokenPair,
} from "../auth/oauth-store.ts";

interface TokenSubject {
  client_id: string;
  user_id: string;
  resource: string;
  scopes: string;
}

interface AuthorizationRequestRow extends TokenSubject {
  redirect_uri: string;
  state: string | null;
  code_challenge: string;
}

interface TokenSecrets {
  accessToken: string;
  accessHash: string;
  refreshToken: string;
  refreshHash: string;
}

function randomToken(bytes = 32): string {
  return Buffer.from(randomBytes(bytes)).toString("base64url");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseScopes(value: string): string[] {
  return value.split(" ").filter(Boolean);
}

function normalizedScopes(scopes: readonly string[]): string[] {
  return [...new Set(scopes.filter(Boolean))].sort();
}

function newTokenSecrets(): TokenSecrets {
  const accessToken = randomToken();
  const refreshToken = randomToken();
  return {
    accessToken,
    accessHash: sha256(accessToken),
    refreshToken,
    refreshHash: sha256(refreshToken),
  };
}

export class SQLiteOAuthStore implements OAuthStore {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  hasGrant(userId: string, clientId: string, resource: string, scopes: string[]): boolean {
    const row = this.#database
      .query("SELECT scopes FROM oauth_grants WHERE user_id = ? AND client_id = ? AND resource = ?")
      .get(userId, clientId, resource) as { scopes: string } | null;
    if (!row) return false;
    const granted = new Set(parseScopes(row.scopes));
    return scopes.every((scope) => granted.has(scope));
  }

  saveGrant(userId: string, clientId: string, resource: string, scopes: string[]): void {
    const existing = this.#database
      .query("SELECT scopes FROM oauth_grants WHERE user_id = ? AND client_id = ? AND resource = ?")
      .get(userId, clientId, resource) as { scopes: string } | null;
    const merged = normalizedScopes([...(existing ? parseScopes(existing.scopes) : []), ...scopes]);
    this.#database.run(
      `
        INSERT INTO oauth_grants (user_id, client_id, resource, scopes, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (user_id, client_id, resource) DO UPDATE SET
          scopes = excluded.scopes,
          updated_at = excluded.updated_at
      `,
      [userId, clientId, resource, merged.join(" "), new Date().toISOString()],
    );
  }

  createAuthorizationRequest(input: AuthorizationRequestInput): AuthorizationRequestTokens {
    const requestToken = randomToken();
    const csrfToken = randomToken();
    this.#database.run(
      `
        INSERT INTO oauth_authorization_requests (
          request_hash, csrf_hash, session_hash, client_id, user_id, redirect_uri,
          resource, scopes, state, code_challenge, expires_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        sha256(requestToken),
        sha256(csrfToken),
        input.sessionHash,
        input.clientId,
        input.userId,
        input.redirectUri,
        input.resource,
        normalizedScopes(input.scopes).join(" "),
        input.state ?? null,
        input.codeChallenge,
        input.expiresAt.toISOString(),
        new Date().toISOString(),
      ],
    );
    return { requestToken, csrfToken };
  }

  consumeAuthorizationRequest(
    requestToken: string,
    csrfToken: string,
    sessionHash: string,
    now: Date,
  ): PendingAuthorizationRequest | undefined {
    const row = this.#database
      .query(
        `
          UPDATE oauth_authorization_requests
          SET consumed_at = ?
          WHERE request_hash = ?
            AND csrf_hash = ?
            AND session_hash = ?
            AND consumed_at IS NULL
            AND expires_at > ?
          RETURNING client_id, user_id, redirect_uri, resource, scopes, state, code_challenge
        `,
      )
      .get(
        now.toISOString(),
        sha256(requestToken),
        sha256(csrfToken),
        sessionHash,
        now.toISOString(),
      ) as AuthorizationRequestRow | null;
    if (!row) return undefined;
    return {
      clientId: row.client_id,
      userId: row.user_id,
      redirectUri: row.redirect_uri,
      resource: row.resource,
      scopes: parseScopes(row.scopes),
      codeChallenge: row.code_challenge,
      ...(row.state ? { state: row.state } : {}),
    };
  }

  createAuthorizationCode(input: AuthorizationCodeInput): string {
    const code = randomToken();
    this.#database.run(
      `
        INSERT INTO authorization_codes (
          code_hash, client_id, user_id, redirect_uri, resource,
          scopes, code_challenge, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        sha256(code),
        input.clientId,
        input.userId,
        input.redirectUri,
        input.resource,
        normalizedScopes(input.scopes).join(" "),
        input.codeChallenge,
        input.expiresAt.toISOString(),
      ],
    );
    return code;
  }

  exchangeAuthorizationCode(input: AuthorizationCodeExchangeInput): TokenPair | undefined {
    const exchange = this.#database.transaction(() => {
      const row = this.#database
        .query(
          `
            UPDATE authorization_codes
            SET consumed_at = ?
            WHERE code_hash = ?
              AND client_id = ?
              AND redirect_uri = ?
              AND code_challenge = ?
              AND consumed_at IS NULL
              AND expires_at > ?
            RETURNING client_id, user_id, resource, scopes
          `,
        )
        .get(
          input.now.toISOString(),
          sha256(input.code),
          input.clientId,
          input.redirectUri,
          input.codeChallenge,
          input.now.toISOString(),
        ) as TokenSubject | null;
      if (!row) return undefined;
      return this.#insertTokenPair(row, newTokenSecrets(), input.now);
    });
    return exchange();
  }

  rotateRefreshToken(input: RefreshTokenExchangeInput): TokenPair | undefined {
    const rotate = this.#database.transaction(() => {
      const secrets = newTokenSecrets();
      const row = this.#database
        .query(
          `
            UPDATE refresh_tokens
            SET revoked_at = ?, replaced_by_hash = ?
            WHERE token_hash = ?
              AND client_id = ?
              AND revoked_at IS NULL
              AND expires_at > ?
            RETURNING client_id, user_id, resource, scopes
          `,
        )
        .get(
          input.now.toISOString(),
          secrets.refreshHash,
          sha256(input.refreshToken),
          input.clientId,
          input.now.toISOString(),
        ) as TokenSubject | null;
      if (!row) return undefined;
      return this.#insertTokenPair(row, secrets, input.now);
    });
    return rotate();
  }

  #insertTokenPair(row: TokenSubject, secrets: TokenSecrets, now: Date): TokenPair {
    const accessExpiry = new Date(now.getTime() + 60 * 60 * 1000);
    const refreshExpiry = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    this.#database.run(
      "INSERT INTO access_tokens (token_hash, client_id, user_id, resource, scopes, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
      [
        secrets.accessHash,
        row.client_id,
        row.user_id,
        row.resource,
        row.scopes,
        accessExpiry.toISOString(),
      ],
    );
    this.#database.run(
      "INSERT INTO refresh_tokens (token_hash, client_id, user_id, resource, scopes, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
      [
        secrets.refreshHash,
        row.client_id,
        row.user_id,
        row.resource,
        row.scopes,
        refreshExpiry.toISOString(),
      ],
    );
    return {
      accessToken: secrets.accessToken,
      refreshToken: secrets.refreshToken,
      expiresIn: 3600,
      scopes: parseScopes(row.scopes),
      resource: row.resource,
    };
  }
}
