# CodeM architecture

## Purpose

CodeM is an MCP capability server for coding agents. It does not decide what code to write. It gives an authenticated client bounded access to workspace reads, process execution, and server-side integrations.

The current deployment target is a modular monolith: one Bun process, one container, and one SQLite database.

## Runtime shape

```text
MCP client
   |
   | stdio or HTTPS
   v
apps/mcp-server
   |-- MCP tool registration and protocol mapping
   |-- Streamable HTTP routes
   |-- embedded OAuth or external introspection
   |-- GitHub App setup/provider
   `-- SQLite composition
           |
           v
packages/core ports <--- packages/adapters
                           Bun process runner
```

The same tool registry is used by stdio and HTTP transports. Transport-specific authentication and policy are applied before a tool handler runs.

## Repository structure

```text
apps/mcp-server/src/
  main.ts                     composition root
  create-server.ts            MCP tools and scope checks
  http-server.ts              HTTP routes and MCP transport
  config.ts                   validated runtime configuration
  application-metadata.ts     canonical name/version/runtime
  auth/                       embedded OAuth and introspection
  github/                     GitHub App setup and API client
  storage/                    SQLite migrations and stores

packages/core/src/
  process/                     portable process contracts
  workspace/                   workspace-boundary policy

packages/adapters/src/
  bun-process-runner.ts        Bun-specific process implementation

tests/e2e/
  stdio.test.ts
  http.test.ts
```

Bun-specific process APIs stay in the adapter package. MCP SDK types and HTTP concerns stay in the application package.

## Configuration and application identity

`CODEM_PUBLIC_URL` is the source of truth for:

- OAuth issuer and endpoints
- protected-resource metadata
- the MCP resource URL
- redirects and Bearer challenges

Only an origin URL with pathname `/` is supported. Rejecting base paths is deliberate: partially rewriting only some OAuth and MCP URLs would create invalid resource and redirect identities.

Application name and version are read from the root `package.json` and reused by MCP metadata, `system.info`, `/health`, and startup logs.

## Authentication boundary

### Embedded OAuth

The embedded authorization server implements:

1. dynamic client registration
2. administrator session authentication
3. authorization request validation
4. explicit consent or reuse of a persisted grant
5. CSRF-bound, single-use pending requests
6. PKCE authorization codes
7. access-token issuance and refresh-token rotation

Consent requests are bound to the user session and expire. Authorization codes and refresh tokens are conditionally consumed in SQLite transactions so concurrent exchanges can produce at most one success.

Embedded OAuth cannot grant `codem:execute` in this release.

### External introspection

The external adapter sends the token and expected resource to an RFC 7662-style introspection endpoint. An active response is accepted only when `aud` or `resource` matches the exact MCP URL. The request has a bounded deadline.

## Persistence boundary

SQLite is the implemented adapter. Startup enables WAL mode, foreign keys, a busy timeout, and ordered schema migrations.

OAuth code depends on the `OAuthStore` interface for:

- persisted grants
- pending authorization requests
- authorization-code creation and exchange
- refresh-token rotation

The interface prevents auth logic from depending on SQLite query details and is the future extension point for PostgreSQL. A PostgreSQL adapter is not included yet.

With SQLite, CodeM runs as one writable replica against one persistent `/data` volume.

## Tool execution flow

1. The transport validates the request and authenticates the caller where required.
2. HTTP mode attaches `AuthInfo` containing resource, client, scopes, and subject.
3. The MCP SDK validates the protocol request and tool schema.
4. CodeM checks the required scope and remote execution policy.
5. The handler resolves workspace-relative paths.
6. A core port invokes the concrete adapter.
7. Output is bounded and mapped to a safe MCP result.

HTTP `codem:read` protects read-only tools. `codem:execute` is required for terminal execution in addition to the server policy switch.

## Process execution boundary

The public terminal contract separates the executable from arguments and never accepts an opaque shell string. The Bun adapter applies:

- workspace-relative `cwd`
- a reduced environment
- stdin and stdout/stderr byte limits
- wall-clock timeout and request cancellation
- a detached process group on supported POSIX systems
- graceful `SIGTERM`, then `SIGKILL` after a bounded grace period
- direct-child fallback when process-group signaling is unavailable

These controls make local execution bounded. They do not replace a container-per-job or microVM sandbox for hostile multi-tenant repositories.

## Outbound network boundary

OAuth introspection and GitHub API calls use one timed fetch helper. It composes caller cancellation with a configured timeout and maps timeout failures to safe errors that omit credentials and response bodies.

## HTTP boundary

The HTTP server provides:

- `/health`
- `/.well-known/oauth-protected-resource`
- `/.well-known/oauth-authorization-server` in embedded mode
- `/setup`, `/login`, and OAuth endpoints
- `/mcp`

Requests must carry an allowed `Host`. Public deployments require HTTPS. OAuth registration accepts HTTPS redirects and HTTP only for loopback hosts.

## Deployment and extraction points

The modular monolith keeps the default deployment easy to operate. Components should be extracted only when a concrete scaling or isolation requirement exists.

Likely future extraction points are:

- PostgreSQL persistence for multiple replicas
- a dedicated sandbox executor
- artifact/blob storage
- distributed job scheduling
- audit/event storage

Public MCP tool contracts should remain stable when those adapters change.
