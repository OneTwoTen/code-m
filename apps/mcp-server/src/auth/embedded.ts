import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { CodeMHttpConfig, EmbeddedAuthConfig } from "../config.ts";
import { UnauthorizedError } from "./introspection.ts";

interface EmbeddedAuthDependencies {
  database: Database;
  config: CodeMHttpConfig & { auth: EmbeddedAuthConfig };
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function randomToken(bytes = 32): string {
  return base64Url(randomBytes(bytes));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function challenge(value: string): string {
  return base64Url(createHash("sha256").update(value).digest());
}

function parseCookies(request: Request): Record<string, string> {
  const header = request.headers.get("cookie") ?? "";
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separator = part.indexOf("=");
        return separator < 0
          ? [part, ""]
          : [part.slice(0, separator), decodeURIComponent(part.slice(separator + 1))];
      }),
  );
}

function html(body: string, status = 200, headers?: HeadersInit): Response {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>CodeM</title></head><body>${body}</body></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        ...headers,
      },
    },
  );
}

function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store", ...headers },
  });
}

function formValue(form: FormData, name: string): string {
  const value = form.get(name);
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required.`);
  return value.trim();
}

function bearerToken(request: Request): string {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) throw new UnauthorizedError();
  const token = header.slice("Bearer ".length).trim();
  if (!token) throw new UnauthorizedError();
  return token;
}

export class EmbeddedAuthorizationServer {
  readonly #database: Database;
  readonly #config: CodeMHttpConfig & { auth: EmbeddedAuthConfig };

  constructor(dependencies: EmbeddedAuthDependencies) {
    this.#database = dependencies.database;
    this.#config = dependencies.config;
  }

  authorizationServerMetadata() {
    const issuer = this.#config.publicUrl.href.replace(/\/$/, "");
    return {
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: this.#config.auth.scopes,
    };
  }

  async verify(request: Request): Promise<AuthInfo> {
    const token = bearerToken(request);
    const row = this.#database
      .query(
        "SELECT client_id, user_id, resource, scopes, expires_at, revoked_at FROM access_tokens WHERE token_hash = ?",
      )
      .get(sha256(token)) as {
      client_id: string;
      user_id: string;
      resource: string;
      scopes: string;
      expires_at: string;
      revoked_at: string | null;
    } | null;

    if (!row || row.revoked_at || Date.parse(row.expires_at) <= Date.now()) {
      throw new UnauthorizedError("Access token is inactive.");
    }
    if (row.resource.replace(/\/$/, "") !== this.#config.mcpUrl.href.replace(/\/$/, "")) {
      throw new UnauthorizedError("Access token is not intended for this resource.");
    }

    return {
      token,
      clientId: row.client_id,
      scopes: row.scopes.split(" ").filter(Boolean),
      expiresAt: Math.floor(Date.parse(row.expires_at) / 1000),
      resource: this.#config.mcpUrl,
      extra: { subject: row.user_id },
    };
  }

  async handle(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
      return json(this.authorizationServerMetadata());
    }
    if (url.pathname === "/setup") return this.#setup(request);
    if (url.pathname === "/login") return this.#login(request);
    if (url.pathname === "/logout") return this.#logout(request);
    if (url.pathname === "/oauth/register") return this.#register(request);
    if (url.pathname === "/oauth/authorize") return this.#authorize(request);
    if (url.pathname === "/oauth/token") return this.#token(request);
    return undefined;
  }

  async #setup(request: Request): Promise<Response> {
    const existing = this.#database.query("SELECT id FROM users LIMIT 1").get();
    if (request.method === "GET") {
      if (existing) return html(`<h1>CodeM is configured</h1><p><a href="/login">Sign in</a></p>`);
      return html(
        `<h1>Set up CodeM</h1><form method="post"><label>Username <input name="username" required></label><br><label>Password <input name="password" type="password" minlength="12" required></label><br><button type="submit">Create administrator</button></form>`,
      );
    }
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    if (existing) return json({ error: "already_configured" }, 409);

    const form = await request.formData();
    const username = formValue(form, "username");
    const password = formValue(form, "password");
    if (password.length < 12) return json({ error: "password_too_short" }, 400);
    const id = `usr_${randomToken(12)}`;
    const passwordHash = await Bun.password.hash(password, { algorithm: "argon2id" });
    this.#database.run(
      "INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, 'admin', ?)",
      [id, username, passwordHash, new Date().toISOString()],
    );
    return Response.redirect(new URL("/login", this.#config.publicUrl), 303);
  }

  async #login(request: Request): Promise<Response> {
    if (request.method === "GET") {
      const next = new URL(request.url).searchParams.get("next") ?? "/setup";
      return html(
        `<h1>Sign in to CodeM</h1><form method="post"><input type="hidden" name="next" value="${encodeURIComponent(next)}"><label>Username <input name="username" required></label><br><label>Password <input name="password" type="password" required></label><br><button type="submit">Sign in</button></form>`,
      );
    }
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    const form = await request.formData();
    const username = formValue(form, "username");
    const password = formValue(form, "password");
    const row = this.#database
      .query("SELECT id, password_hash FROM users WHERE username = ?")
      .get(username) as { id: string; password_hash: string } | null;
    if (!row || !(await Bun.password.verify(password, row.password_hash))) {
      return html("<h1>Invalid credentials</h1>", 401);
    }
    const session = randomToken();
    this.#database.run(
      "INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
      [
        sha256(session),
        row.id,
        new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        new Date().toISOString(),
      ],
    );
    const nextValue = form.get("next");
    const next = typeof nextValue === "string" && nextValue.startsWith("/") ? nextValue : "/setup";
    return new Response(null, {
      status: 303,
      headers: {
        location: new URL(next, this.#config.publicUrl).href,
        "set-cookie": `codem_session=${encodeURIComponent(session)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`,
      },
    });
  }

  #logout(request: Request): Response {
    const session = parseCookies(request).codem_session;
    if (session) this.#database.run("DELETE FROM sessions WHERE id = ?", [sha256(session)]);
    return new Response(null, {
      status: 303,
      headers: {
        location: new URL("/login", this.#config.publicUrl).href,
        "set-cookie": "codem_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
      },
    });
  }

  async #register(request: Request): Promise<Response> {
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    const payload = (await request.json()) as { redirect_uris?: unknown; client_name?: unknown };
    if (!Array.isArray(payload.redirect_uris) || payload.redirect_uris.length === 0) {
      return json({ error: "invalid_client_metadata" }, 400);
    }
    const redirectUris = payload.redirect_uris.filter(
      (value): value is string => typeof value === "string" && /^https?:\/\//.test(value),
    );
    if (redirectUris.length !== payload.redirect_uris.length) {
      return json({ error: "invalid_redirect_uri" }, 400);
    }
    const clientId = `client_${randomToken(18)}`;
    this.#database.run(
      "INSERT INTO oauth_clients (client_id, redirect_uris, client_name, created_at) VALUES (?, ?, ?, ?)",
      [
        clientId,
        JSON.stringify(redirectUris),
        typeof payload.client_name === "string" ? payload.client_name : null,
        new Date().toISOString(),
      ],
    );
    return json(
      {
        client_id: clientId,
        redirect_uris: redirectUris,
        client_name: typeof payload.client_name === "string" ? payload.client_name : undefined,
        token_endpoint_auth_method: "none",
      },
      201,
    );
  }

  async #authorize(request: Request): Promise<Response> {
    if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
    const url = new URL(request.url);
    const clientId = url.searchParams.get("client_id") ?? "";
    const redirectUri = url.searchParams.get("redirect_uri") ?? "";
    const resource = url.searchParams.get("resource") ?? "";
    const scope = url.searchParams.get("scope") ?? "";
    const state = url.searchParams.get("state");
    const codeChallenge = url.searchParams.get("code_challenge") ?? "";
    if (
      url.searchParams.get("response_type") !== "code" ||
      url.searchParams.get("code_challenge_method") !== "S256"
    ) {
      return json({ error: "invalid_request" }, 400);
    }
    const client = this.#database
      .query("SELECT redirect_uris FROM oauth_clients WHERE client_id = ?")
      .get(clientId) as { redirect_uris: string } | null;
    if (!client || !(JSON.parse(client.redirect_uris) as string[]).includes(redirectUri)) {
      return json({ error: "invalid_client" }, 400);
    }
    if (resource.replace(/\/$/, "") !== this.#config.mcpUrl.href.replace(/\/$/, "")) {
      return json({ error: "invalid_target" }, 400);
    }
    const requestedScopes = scope.split(" ").filter(Boolean);
    if (requestedScopes.some((value) => !this.#config.auth.scopes.includes(value))) {
      return json({ error: "invalid_scope" }, 400);
    }

    const session = parseCookies(request).codem_session;
    const user = session
      ? (this.#database
          .query("SELECT user_id FROM sessions WHERE id = ? AND expires_at > ?")
          .get(sha256(session), new Date().toISOString()) as { user_id: string } | null)
      : null;
    if (!user) {
      const next = `${url.pathname}${url.search}`;
      return Response.redirect(
        new URL(`/login?next=${encodeURIComponent(next)}`, this.#config.publicUrl),
        303,
      );
    }

    const code = randomToken();
    this.#database.run(
      "INSERT INTO authorization_codes (code_hash, client_id, user_id, redirect_uri, resource, scopes, code_challenge, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        sha256(code),
        clientId,
        user.user_id,
        redirectUri,
        resource,
        requestedScopes.join(" "),
        codeChallenge,
        new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      ],
    );
    const redirect = new URL(redirectUri);
    redirect.searchParams.set("code", code);
    if (state) redirect.searchParams.set("state", state);
    return Response.redirect(redirect, 303);
  }

  async #token(request: Request): Promise<Response> {
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    const form = await request.formData();
    const grantType = formValue(form, "grant_type");
    if (grantType === "authorization_code") return this.#exchangeAuthorizationCode(form);
    if (grantType === "refresh_token") return this.#exchangeRefreshToken(form);
    return json({ error: "unsupported_grant_type" }, 400);
  }

  #issueTokens(clientId: string, userId: string, resource: string, scopes: string): Response {
    const accessToken = randomToken();
    const refreshToken = randomToken();
    const now = new Date();
    const accessExpiry = new Date(now.getTime() + 60 * 60 * 1000);
    const refreshExpiry = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    this.#database.transaction(() => {
      this.#database.run(
        "INSERT INTO access_tokens (token_hash, client_id, user_id, resource, scopes, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
        [sha256(accessToken), clientId, userId, resource, scopes, accessExpiry.toISOString()],
      );
      this.#database.run(
        "INSERT INTO refresh_tokens (token_hash, client_id, user_id, resource, scopes, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
        [sha256(refreshToken), clientId, userId, resource, scopes, refreshExpiry.toISOString()],
      );
    })();
    return json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: refreshToken,
      scope: scopes,
      resource,
    });
  }

  #exchangeAuthorizationCode(form: FormData): Response {
    const code = formValue(form, "code");
    const clientId = formValue(form, "client_id");
    const redirectUri = formValue(form, "redirect_uri");
    const verifier = formValue(form, "code_verifier");
    const row = this.#database
      .query(
        "SELECT client_id, user_id, redirect_uri, resource, scopes, code_challenge, expires_at, consumed_at FROM authorization_codes WHERE code_hash = ?",
      )
      .get(sha256(code)) as {
      client_id: string;
      user_id: string;
      redirect_uri: string;
      resource: string;
      scopes: string;
      code_challenge: string;
      expires_at: string;
      consumed_at: string | null;
    } | null;
    const actualChallenge = challenge(verifier);
    const challengeMatches =
      row &&
      row.code_challenge.length === actualChallenge.length &&
      timingSafeEqual(Buffer.from(row.code_challenge), Buffer.from(actualChallenge));
    if (
      !row ||
      row.consumed_at ||
      Date.parse(row.expires_at) <= Date.now() ||
      row.client_id !== clientId ||
      row.redirect_uri !== redirectUri ||
      !challengeMatches
    ) {
      return json({ error: "invalid_grant" }, 400);
    }
    this.#database.run("UPDATE authorization_codes SET consumed_at = ? WHERE code_hash = ?", [
      new Date().toISOString(),
      sha256(code),
    ]);
    return this.#issueTokens(row.client_id, row.user_id, row.resource, row.scopes);
  }

  #exchangeRefreshToken(form: FormData): Response {
    const refreshToken = formValue(form, "refresh_token");
    const clientId = formValue(form, "client_id");
    const hash = sha256(refreshToken);
    const row = this.#database
      .query(
        "SELECT client_id, user_id, resource, scopes, expires_at, revoked_at FROM refresh_tokens WHERE token_hash = ?",
      )
      .get(hash) as {
      client_id: string;
      user_id: string;
      resource: string;
      scopes: string;
      expires_at: string;
      revoked_at: string | null;
    } | null;
    if (
      !row ||
      row.client_id !== clientId ||
      row.revoked_at ||
      Date.parse(row.expires_at) <= Date.now()
    ) {
      return json({ error: "invalid_grant" }, 400);
    }
    this.#database.run("UPDATE refresh_tokens SET revoked_at = ? WHERE token_hash = ?", [
      new Date().toISOString(),
      hash,
    ]);
    return this.#issueTokens(row.client_id, row.user_id, row.resource, row.scopes);
  }
}
