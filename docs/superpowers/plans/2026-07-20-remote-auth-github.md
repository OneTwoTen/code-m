# Remote Auth and GitHub App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a ChatGPT-compatible remote MCP resource server and prove a server-side GitHub App installation can authenticate without exposing credentials.

**Architecture:** Keep stdio unchanged for local agents. Add a stateless Bun Streamable HTTP entrypoint protected by RFC 7662 token introspection and RFC 9728 metadata. Add a GitHub App adapter that creates short-lived installation tokens and exposes a read-only connection status tool.

**Tech Stack:** Bun 1.3.3, TypeScript strict mode, Biome, MCP TypeScript SDK 1.29.0, Zod 4, Node crypto, Web Standard fetch.

## Global Constraints

- Biome remains the only formatter and linter.
- Core packages do not import Bun, MCP, OAuth, or GitHub-specific code.
- HTTP mode requires OAuth bearer authentication.
- CodeM is an OAuth resource server, not an authorization server.
- GitHub tokens and private keys never appear in tool output or logs.
- Remote terminal execution remains disabled unless explicitly enabled.
- Existing stdio tests must continue to pass.

---

### Task 1: Runtime configuration

**Files:**
- Create: `apps/mcp-server/src/config.test.ts`
- Create: `apps/mcp-server/src/config.ts`
- Modify: `.env.example`

**Produces:** `loadCodeMConfig(env)` with discriminated stdio and HTTP configurations.

- [ ] Test stdio defaults to the current workspace.
- [ ] Test HTTP mode rejects missing public URL, issuer, introspection credentials, and host allowlist.
- [ ] Test escaped GitHub private-key newlines are normalized.
- [ ] Implement strict environment parsing without logging secret values.
- [ ] Run `bun test apps/mcp-server/src/config.test.ts`.

### Task 2: OAuth resource-server adapter

**Files:**
- Create: `apps/mcp-server/src/auth/introspection.test.ts`
- Create: `apps/mcp-server/src/auth/introspection.ts`
- Create: `apps/mcp-server/src/auth/protected-resource.ts`

**Produces:**

```ts
interface AccessTokenVerifier {
  verify(request: Request): Promise<AuthInfo>;
}
```

- [ ] Test missing bearer tokens return a typed unauthorized error.
- [ ] Test successful introspection maps `scope`, `client_id`, `sub`, and `exp`.
- [ ] Test inactive tokens and audience mismatches are rejected.
- [ ] Implement RFC 7662 POST with Basic client authentication.
- [ ] Implement RFC 9728 protected-resource metadata.
- [ ] Verify no errors contain access-token or client-secret values.

### Task 3: Remote Streamable HTTP server

**Files:**
- Create: `apps/mcp-server/src/http-server.test.ts`
- Create: `apps/mcp-server/src/http-server.ts`
- Modify: `apps/mcp-server/src/main.ts`

**Produces:** `startHttpServer(config, dependencies)` and `/mcp`, `/health`, and protected-resource metadata routes.

- [ ] Test `/health` succeeds without authentication.
- [ ] Test protected-resource metadata is publicly readable.
- [ ] Test `/mcp` returns a bearer challenge without authentication.
- [ ] Test authenticated MCP initialization and tool listing.
- [ ] Use a fresh stateless `WebStandardStreamableHTTPServerTransport` per request.
- [ ] Preserve the existing stdio startup path.

### Task 4: GitHub App installation token provider

**Files:**
- Create: `apps/mcp-server/src/github/github-app.test.ts`
- Create: `apps/mcp-server/src/github/github-app.ts`

**Produces:** `GitHubAppClient.getConnectionStatus()`.

- [ ] Test RS256 app JWT claims use a maximum ten-minute lifetime.
- [ ] Test installation token exchange uses the configured installation ID.
- [ ] Test installation tokens are cached until sixty seconds before expiry.
- [ ] Test connection status returns repository count, preview, permissions, and selection.
- [ ] Normalize GitHub API errors without credentials.

### Task 5: GitHub connection MCP tool and scopes

**Files:**
- Modify: `apps/mcp-server/src/create-server.ts`
- Modify: `apps/mcp-server/src/tool-handlers.ts`
- Modify: `apps/mcp-server/src/tool-handlers.test.ts`

**Produces:** MCP tool `github.connection_status` and scope enforcement for remote calls.

- [ ] Add the read-only idempotent tool.
- [ ] Return `configured=false` when GitHub App settings are absent.
- [ ] Require `codem:read` for remote read tools.
- [ ] Require `codem:execute` for `terminal.exec`.
- [ ] Keep stdio calls authorized by the local process boundary.

### Task 6: Deployment and verification

**Files:**
- Modify: `Dockerfile`
- Modify: `README.md`
- Modify: `docs/security-model.md`
- Modify: `.github/workflows/ci.yml`

- [ ] Document Auth0/Okta/Cognito as authorization-server examples without coupling CodeM to one provider.
- [ ] Document GitHub App permissions and environment variables.
- [ ] Add HTTP-mode Docker example without embedding secrets in the image.
- [ ] Run `bun run check`.
- [ ] Build the Docker image in CI.
- [ ] Add an HTTP MCP end-to-end test with a fake introspection server.
- [ ] Confirm CI has zero failures.