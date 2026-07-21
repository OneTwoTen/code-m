import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { CodeMHttpConfig } from "../config.ts";
import { GitHubAppClient } from "./github-app.ts";
import type { GitHubConfigStore } from "./github-config-store.ts";
import type { DatabaseBackedGitHubProvider } from "./github-provider.ts";

interface ManifestConversion {
  id: number;
  slug: string;
  pem: string;
  client_id?: string;
  client_secret?: string;
  webhook_secret?: string;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[char] ?? char;
  });
}

function html(body: string, status = 200): Response {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>CodeM GitHub setup</title></head><body>${body}</body></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}

function parseCookies(request: Request): Record<string, string> {
  return Object.fromEntries(
    (request.headers.get("cookie") ?? "")
      .split(";")
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => {
        const index = value.indexOf("=");
        return index < 0
          ? [value, ""]
          : [value.slice(0, index), decodeURIComponent(value.slice(index + 1))];
      }),
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export class GitHubSetupController {
  readonly #database: Database;
  readonly #config: CodeMHttpConfig;
  readonly #store: GitHubConfigStore;
  readonly #provider: DatabaseBackedGitHubProvider;

  constructor(
    database: Database,
    config: CodeMHttpConfig,
    store: GitHubConfigStore,
    provider: DatabaseBackedGitHubProvider,
  ) {
    this.#database = database;
    this.#config = config;
    this.#store = store;
    this.#provider = provider;
  }

  #session(request: Request): { hash: string; userId: string } | undefined {
    const token = parseCookies(request).codem_session;
    if (!token) return undefined;

    const hash = sha256(token);
    const row = this.#database
      .query(
        "SELECT sessions.user_id FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.id = ? AND sessions.expires_at > ? AND users.role = 'admin'",
      )
      .get(hash, new Date().toISOString()) as { user_id: string } | null;

    return row ? { hash, userId: row.user_id } : undefined;
  }

  #csrf(sessionHash: string): string {
    return createHmac("sha256", this.#config.secretKey)
      .update(`github-setup:${sessionHash}`)
      .digest("base64url");
  }

  #validCsrf(request: Request, sessionHash: string, form: FormData): boolean {
    const actual = form.get("csrf");
    const expected = this.#csrf(sessionHash);
    return (
      typeof actual === "string" &&
      actual.length === expected.length &&
      timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
    );
  }

  async handle(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/setup/github")) return undefined;

    const session = this.#session(request);
    if (!session) {
      return Response.redirect(
        new URL(
          `/login?next=${encodeURIComponent(url.pathname + url.search)}`,
          this.#config.publicUrl,
        ),
        303,
      );
    }

    if (request.method === "GET" && url.pathname === "/setup/github") {
      return this.#status(session.hash);
    }
    if (request.method === "POST" && url.pathname === "/setup/github/manifest") {
      return this.#startManifest(request, session.hash);
    }
    if (request.method === "GET" && url.pathname === "/setup/github/manifest/callback") {
      return this.#manifestCallback(url, session.hash);
    }
    if (request.method === "GET" && url.pathname === "/setup/github/install/callback") {
      return this.#installCallback(url, session.hash);
    }
    if (request.method === "POST" && url.pathname === "/setup/github/test") {
      return this.#test(request, session.hash);
    }
    if (request.method === "POST" && url.pathname === "/setup/github/disconnect") {
      return this.#disconnect(request, session.hash);
    }

    return html("<h1>Not found</h1>", 404);
  }

  async #status(sessionHash: string): Promise<Response> {
    const status = await this.#provider.getConnectionStatus();
    const repositories =
      status.repositories
        ?.map((repository) => `<li>${escapeHtml(repository.fullName)}</li>`)
        .join("") ?? "";
    const state = status.configured ? "Connected" : "Not connected";

    return html(
      `<h1>GitHub integration</h1><p>Status: ${state}</p>${status.error ? `<p>${escapeHtml(status.error)}</p>` : ""}<ul>${repositories}</ul><form method="post" action="/setup/github/manifest"><input type="hidden" name="csrf" value="${this.#csrf(sessionHash)}"><button>Connect GitHub</button></form><form method="post" action="/setup/github/test"><input type="hidden" name="csrf" value="${this.#csrf(sessionHash)}"><button>Test connection</button></form><form method="post" action="/setup/github/disconnect"><input type="hidden" name="csrf" value="${this.#csrf(sessionHash)}"><button>Disconnect</button></form>`,
    );
  }

  async #startManifest(request: Request, sessionHash: string): Promise<Response> {
    const form = await request.formData();
    if (!this.#validCsrf(request, sessionHash, form)) {
      return html("<h1>Invalid CSRF token</h1>", 403);
    }

    const manifestState = this.#store.createState(sessionHash, "manifest");
    const installState = this.#store.createState(sessionHash, "install", 60 * 60 * 1000);
    const manifest = {
      name: "CodeM",
      url: this.#config.publicUrl.href,
      redirect_url: new URL("/setup/github/manifest/callback", this.#config.publicUrl).href,
      setup_url: new URL(
        `/setup/github/install/callback?state=${encodeURIComponent(installState)}`,
        this.#config.publicUrl,
      ).href,
      public: false,
      default_permissions: {
        contents: "write",
        metadata: "read",
        pull_requests: "write",
        issues: "write",
      },
      default_events: [],
    };

    return html(
      `<form id="github-manifest" method="post" action="https://github.com/settings/apps/new"><input type="hidden" name="state" value="${escapeHtml(manifestState)}"><input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}"></form><script>document.getElementById('github-manifest').submit()</script>`,
    );
  }

  async #manifestCallback(url: URL, sessionHash: string): Promise<Response> {
    const state = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("code") ?? "";
    if (!code || !this.#store.consumeState(state, sessionHash, "manifest")) {
      return html("<h1>Invalid or expired setup state</h1>", 400);
    }

    const response = await fetch(
      `https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`,
      {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": "2026-03-10",
        },
      },
    );
    if (!response.ok) {
      return html(`<h1>GitHub manifest exchange failed (${response.status})</h1>`, 502);
    }

    const result = (await response.json()) as ManifestConversion;
    this.#store.save({
      appId: String(result.id),
      privateKey: result.pem,
      installationId: "",
      apiUrl: "https://api.github.com",
      clientId: result.client_id,
      clientSecret: result.client_secret,
      webhookSecret: result.webhook_secret,
    });
    this.#provider.invalidate();

    return Response.redirect(
      `https://github.com/apps/${encodeURIComponent(result.slug)}/installations/new`,
      303,
    );
  }

  async #installCallback(url: URL, sessionHash: string): Promise<Response> {
    const state = url.searchParams.get("state") ?? "";
    const installationId = url.searchParams.get("installation_id") ?? "";
    if (
      !/^\d+$/.test(installationId) ||
      !this.#store.consumeState(state, sessionHash, "install")
    ) {
      return html("<h1>Invalid installation callback</h1>", 400);
    }

    const pending = this.#store.loadPending();
    if (!pending) return html("<h1>GitHub App credentials are missing</h1>", 409);

    const candidate = { ...pending, installationId };
    const status = await new GitHubAppClient(candidate).getConnectionStatus();
    if (!status.authenticated || !status.reachable) {
      return html(
        `<h1>GitHub installation validation failed</h1><p>${escapeHtml(status.error ?? "Unknown error")}</p>`,
        502,
      );
    }

    this.#store.save(candidate);
    this.#provider.invalidate();
    return Response.redirect(new URL("/setup/github", this.#config.publicUrl), 303);
  }

  async #test(request: Request, sessionHash: string): Promise<Response> {
    const form = await request.formData();
    if (!this.#validCsrf(request, sessionHash, form)) {
      return html("<h1>Invalid CSRF token</h1>", 403);
    }

    const status = await this.#provider.getConnectionStatus();
    return html(
      `<h1>GitHub connection test</h1><pre>${escapeHtml(JSON.stringify(status, null, 2))}</pre><p><a href="/setup/github">Back</a></p>`,
      status.authenticated ? 200 : 502,
    );
  }

  async #disconnect(request: Request, sessionHash: string): Promise<Response> {
    const form = await request.formData();
    if (!this.#validCsrf(request, sessionHash, form)) {
      return html("<h1>Invalid CSRF token</h1>", 403);
    }

    this.#store.disconnect();
    this.#provider.invalidate();
    return Response.redirect(new URL("/setup/github", this.#config.publicUrl), 303);
  }
}
