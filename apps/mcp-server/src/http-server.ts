import type { Database } from "bun:sqlite";
import type { ProcessRunner } from "@codem/core";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CODEM_APPLICATION, runtimeVersion } from "./application-metadata.ts";
import { EmbeddedAuthorizationServer } from "./auth/embedded.ts";
import { IntrospectionAccessTokenVerifier, UnauthorizedError } from "./auth/introspection.ts";
import {
  createBearerChallenge,
  createProtectedResourceMetadata,
} from "./auth/protected-resource.ts";
import type { CodeMHttpConfig, ExternalAuthConfig } from "./config.ts";
import { createCodeMServer } from "./create-server.ts";
import type { GitHubConnectionProvider } from "./create-server.ts";
import type { GitHubSetupController } from "./github/github-setup-controller.ts";
import { SQLiteOAuthStore } from "./storage/sqlite-oauth-store.ts";

export interface HttpServerDependencies {
  workspaceRoot: string;
  processRunner: ProcessRunner;
  database: Database;
  github?: GitHubConnectionProvider;
  githubSetup?: GitHubSetupController;
}

function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
      ...Object.fromEntries(new Headers(headers).entries()),
    },
  });
}

function isSafeLocalPath(value: string): boolean {
  return value.startsWith("/") && !value.startsWith("//") && !value.includes("\\");
}

async function setupTokenMatches(request: Request): Promise<boolean> {
  const expected = process.env.CODEM_SETUP_TOKEN?.trim();
  if (!expected) return false;

  const header = request.headers.get("x-codem-setup-token")?.trim();
  if (header === expected) return true;

  const url = new URL(request.url);
  if (url.searchParams.get("setup_token") === expected) return true;

  if (request.method === "POST") {
    const form = await request
      .clone()
      .formData()
      .catch(() => undefined);
    return form?.get("setup_token") === expected;
  }
  return false;
}

async function validateEmbeddedRequest(request: Request): Promise<Response | undefined> {
  const url = new URL(request.url);

  if (url.pathname === "/setup" && !(await setupTokenMatches(request))) {
    return json(
      {
        error: "setup_token_required",
        message: "Set CODEM_SETUP_TOKEN and provide it as x-codem-setup-token.",
      },
      403,
    );
  }

  if (url.pathname === "/oauth/authorize") {
    const scopes = (url.searchParams.get("scope") ?? "").split(/\s+/).filter(Boolean);
    if (scopes.includes("codem:execute")) {
      return json({ error: "invalid_scope", message: "codem:execute is not grantable yet." }, 400);
    }
  }

  if (url.pathname === "/oauth/register" && request.method === "POST") {
    const payload = (await request
      .clone()
      .json()
      .catch(() => undefined)) as { redirect_uris?: unknown } | undefined;
    const redirectUris = Array.isArray(payload?.redirect_uris) ? payload.redirect_uris : [];
    const valid = redirectUris.every((value) => {
      if (typeof value !== "string") return false;
      try {
        const redirect = new URL(value);
        const loopback = redirect.hostname === "localhost" || redirect.hostname === "127.0.0.1";
        return redirect.protocol === "https:" || (loopback && redirect.protocol === "http:");
      } catch {
        return false;
      }
    });
    if (!valid) return json({ error: "invalid_redirect_uri" }, 400);
  }

  return undefined;
}

async function normalizeEmbeddedResponse(
  request: Request,
  response: Response,
  publicUrl: URL,
): Promise<Response> {
  const headers = new Headers(response.headers);
  const cookie = headers.get("set-cookie");
  if (cookie && publicUrl.protocol !== "https:") {
    headers.set("set-cookie", cookie.replace(/; Secure/gi, ""));
  }

  if (request.method === "POST" && new URL(request.url).pathname === "/login") {
    const form = await request
      .clone()
      .formData()
      .catch(() => undefined);
    const rawNext = form?.get("next");
    if (typeof rawNext === "string") {
      const decoded = decodeURIComponent(rawNext);
      if (isSafeLocalPath(decoded)) {
        headers.set("location", new URL(decoded, publicUrl).href);
      }
    }
  }

  return new Response(response.body, { status: response.status, headers });
}

export function createHttpHandler(
  config: CodeMHttpConfig,
  dependencies: HttpServerDependencies,
): (request: Request) => Promise<Response> {
  const embedded =
    config.auth.provider === "embedded"
      ? new EmbeddedAuthorizationServer({
          database: dependencies.database,
          store: new SQLiteOAuthStore(dependencies.database),
          config: config as CodeMHttpConfig & {
            auth: Extract<CodeMHttpConfig["auth"], { provider: "embedded" }>;
          },
        })
      : undefined;
  const external =
    config.auth.provider === "external-oidc"
      ? new IntrospectionAccessTokenVerifier({
          introspectionUrl: (config.auth as ExternalAuthConfig).introspectionUrl,
          clientId: (config.auth as ExternalAuthConfig).clientId,
          clientSecret: (config.auth as ExternalAuthConfig).clientSecret,
          resource: config.mcpUrl,
          timeoutMs: config.outboundHttpTimeoutMs,
        })
      : undefined;
  const metadata = createProtectedResourceMetadata({
    resource: config.mcpUrl,
    authorizationServer: config.auth.issuer,
    scopes: config.auth.scopes,
  });

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const host = request.headers.get("host");
    if (!host || !config.allowedHosts.includes(host)) {
      return json({ error: "invalid_host" }, 403);
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return json({
        status: "ok",
        application: CODEM_APPLICATION,
        runtime: runtimeVersion(),
        transport: "http",
        database: "ready",
      });
    }

    if (request.method === "GET" && url.pathname === "/.well-known/oauth-protected-resource") {
      return json(metadata);
    }

    const githubSetupResponse = await dependencies.githubSetup?.handle(request);
    if (githubSetupResponse) return githubSetupResponse;

    if (embedded) {
      const rejected = await validateEmbeddedRequest(request);
      if (rejected) return rejected;
      const authResponse = await embedded.handle(request);
      if (authResponse) {
        return normalizeEmbeddedResponse(request, authResponse, config.publicUrl);
      }
    }

    if (url.pathname !== "/mcp") return json({ error: "not_found" }, 404);
    if (request.method !== "POST") {
      return json({ error: "method_not_allowed" }, 405, { allow: "POST" });
    }

    try {
      const authInfo = embedded ? await embedded.verify(request) : await external?.verify(request);
      if (!authInfo) throw new UnauthorizedError();
      const server = createCodeMServer({
        workspaceRoot: dependencies.workspaceRoot,
        processRunner: dependencies.processRunner,
        remoteMode: true,
        allowRemoteTerminal: config.allowRemoteTerminal,
        github: dependencies.github,
      });
      const transport = new WebStandardStreamableHTTPServerTransport({
        enableJsonResponse: true,
      });
      await server.connect(transport);
      return await transport.handleRequest(request, { authInfo });
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        return json({ error: "unauthorized", message: error.message }, 401, {
          "www-authenticate": createBearerChallenge(config.mcpUrl),
        });
      }
      const message = error instanceof Error ? error.message : "Internal server error.";
      console.error(`CodeM HTTP request failed: ${message}`);
      return json({ error: "internal_server_error" }, 500);
    }
  };
}

export function startHttpServer(
  config: CodeMHttpConfig,
  dependencies: HttpServerDependencies,
): ReturnType<typeof Bun.serve> {
  const fetch = createHttpHandler(config, dependencies);
  return Bun.serve({ hostname: config.host, port: config.port, fetch });
}
