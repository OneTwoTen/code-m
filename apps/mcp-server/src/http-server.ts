import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { ProcessRunner } from "@codem/core";
import type { CodeMHttpConfig } from "./config.ts";
import { IntrospectionAccessTokenVerifier, UnauthorizedError } from "./auth/introspection.ts";
import {
  createBearerChallenge,
  createProtectedResourceMetadata,
} from "./auth/protected-resource.ts";
import { createCodeMServer } from "./create-server.ts";
import type { GitHubConnectionProvider } from "./create-server.ts";

export interface HttpServerDependencies {
  workspaceRoot: string;
  processRunner: ProcessRunner;
  github?: GitHubConnectionProvider;
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
  const verifier = new IntrospectionAccessTokenVerifier({
    introspectionUrl: config.auth.introspectionUrl,
    clientId: config.auth.clientId,
    clientSecret: config.auth.clientSecret,
    resource: config.publicUrl,
  });
  const metadata = createProtectedResourceMetadata({
    resource: config.publicUrl,
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
      return json({ status: "ok", transport: "http" });
    }

    if (
      request.method === "GET" &&
      url.pathname === "/.well-known/oauth-protected-resource"
    ) {
      return json(metadata);
    }

    if (url.pathname !== "/mcp") {
      return json({ error: "not_found" }, 404);
    }

    if (request.method !== "POST") {
      return json({ error: "method_not_allowed" }, 405, { allow: "POST" });
    }

    try {
      const authInfo = await verifier.verify(request);
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
        return json(
          { error: "unauthorized", message: error.message },
          401,
          { "www-authenticate": createBearerChallenge(config.publicUrl) },
        );
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
