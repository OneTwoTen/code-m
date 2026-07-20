import type { Database } from "bun:sqlite";
import type { ProcessRunner } from "@codem/core";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
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

export function createHttpHandler(
  config: CodeMHttpConfig,
  dependencies: HttpServerDependencies,
): (request: Request) => Promise<Response> {
  const embedded =
    config.auth.provider === "embedded"
      ? new EmbeddedAuthorizationServer({
          database: dependencies.database,
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
      return json({ status: "ok", transport: "http", database: "ready" });
    }

    if (request.method === "GET" && url.pathname === "/.well-known/oauth-protected-resource") {
      return json(metadata);
    }

    const githubSetupResponse = await dependencies.githubSetup?.handle(request);
    if (githubSetupResponse) return githubSetupResponse;

    const authResponse = await embedded?.handle(request);
    if (authResponse) return authResponse;

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
        sessionIdGenerator: undefined,
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
