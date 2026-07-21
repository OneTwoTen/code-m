# Issue 2 Follow-up Hardening Design

## Context

PR #1 delivered the Bun-based MCP MVP and intentionally deferred several production-hardening items from issue #2. PR #2 completes those deferred items without changing the product principle: the default self-hosted path remains one CodeM service, one `/data` volume, one public URL, one application secret, guided GitHub setup, and one MCP URL.

## Considered approaches

### 1. Large rewrite around a new framework

Move auth, persistence, HTTP routing, and process execution to new libraries in one pass.

**Trade-off:** could reduce custom code, but creates a high-risk migration with weak review boundaries and unnecessary dependency churn.

### 2. Targeted hardening behind focused interfaces — selected

Keep the existing Bun/TypeScript modular monolith, add narrow storage and network boundaries, harden process execution in place, and expand integration tests around externally visible behavior.

**Trade-off:** retains some existing implementation structure, but minimizes regression risk and lets each deferred requirement be reviewed independently.

### 3. Documentation-only deferral

Document limitations and leave runtime behavior unchanged.

**Trade-off:** smallest PR, but does not satisfy issue #2 security and reliability acceptance criteria.

## Architecture

PR #2 keeps `apps/mcp-server` as the composition root and introduces four explicit boundaries:

1. **Application metadata** owns the CodeM name/version/runtime values used by MCP, health responses, and startup logs.
2. **OAuth storage operations** own consent grants and atomic authorization-code/refresh-token exchanges. SQLite implements the operations with immediate transactions; future PostgreSQL support implements the same interface.
3. **Timed outbound HTTP** owns request deadlines for OAuth introspection and GitHub API calls.
4. **Process termination policy** owns graceful termination, escalation, process-group cleanup on supported platforms, and request-level execution limits.

The public URL remains the single source of truth. Non-root `CODEM_PUBLIC_URL` paths are rejected explicitly in this PR instead of partially supporting base paths.

## Embedded OAuth consent and grants

`GET /oauth/authorize` validates the request, authenticates the session, and renders a consent form rather than issuing a code immediately. The form contains a server-generated CSRF token bound to the session and authorization request. `POST /oauth/authorize` validates CSRF, records a persisted grant for the user/client/resource/scope set, and then creates the authorization code.

Existing grants may skip the consent UI only when the requested scopes are a subset of the stored grant. A denial returns an OAuth error redirect. CSRF tokens and authorization requests are short-lived and single-use.

`codem:execute` remains unavailable to embedded OAuth until the remote executor is considered safe enough for production. The consent implementation therefore does not weaken the current scope policy.

## Atomic token exchange

Authorization-code consumption and token issuance occur in one database transaction. The code row is conditionally updated only when unconsumed and unexpired; a zero-row update means `invalid_grant`.

Refresh-token rotation occurs in one transaction. The existing refresh token is conditionally revoked, replacement access/refresh tokens are inserted, and `replaced_by_hash` links the rotation. Concurrent attempts can produce at most one successful rotation.

The application depends on an `OAuthStore` interface rather than direct SQL for these operations. SQLite is the production implementation in this PR. A PostgreSQL adapter is documented as an advanced future implementation and the interface prevents SQLite-specific behavior from leaking into auth logic.

## External token verification and outbound HTTP

External introspection must return an audience or resource value matching the MCP URL. Missing audience/resource claims are rejected.

OAuth introspection and all GitHub API requests use an `AbortSignal.timeout` deadline. Timeout failures are converted to safe, actionable errors without exposing credentials or response bodies.

## Process execution hardening

The Bun adapter starts commands in a separate process group on POSIX platforms where supported. Timeout or cancellation sends a graceful termination signal, waits a short grace period, then escalates to a hard kill. The policy attempts process-group termination first and falls back to the direct child process.

Execution requests carry explicit limits for timeout, stdout/stderr bytes, stdin bytes, and termination grace. CodeM continues to pass an executable and argument array without a shell. Remote terminal remains disabled by default.

## Configuration and metadata

`CODEM_PUBLIC_URL` must be an origin URL with pathname `/`. URLs containing a non-root base path fail at startup with a clear message.

The root package version is the only CodeM application version. A small metadata module reads the package version and is used by MCP server metadata, `system.info`, `/health`, and startup logs.

## Testing

The test suite adds:

- configuration rejection for non-root public paths
- external introspection tests for required audience/resource and timeout behavior
- embedded OAuth HTTP integration tests for consent POST, CSRF, persisted grants, one-time codes, and refresh rotation
- SQLite tests for atomic code consumption and refresh rotation through two database connections
- GitHub client tests for outbound timeout behavior and safe errors
- process-runner tests for timeout/cancellation escalation and configured limits
- HTTP integration tests for metadata, OAuth challenges, health, and protected MCP behavior
- version consistency tests across package metadata, MCP `system.info`, health, and startup-facing metadata

## Documentation and deployment

README and deployment documentation put the one-container SQLite path first, explain `/data`, setup token, embedded auth, GitHub setup, backup/restore, migration behavior, scaling limits, external OIDC, and PostgreSQL as advanced options.

## Non-goals

- shipping a production PostgreSQL adapter
- enabling remote terminal by default
- implementing a hardened multi-tenant sandbox
- supporting public URL base paths
- automatic managed backups
- exposing GitHub or OAuth credentials through MCP
