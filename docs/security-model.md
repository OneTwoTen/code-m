# Security model

## Deployment assumption

The current release targets a single-operator, self-hosted CodeM instance. MCP clients, model-generated arguments, repository content, command output, OAuth clients, and downloaded dependencies are untrusted.

The CodeM process, its application secret, SQLite volume, reverse proxy, and deployment operator are trusted. The current process runner is not a hardened multi-tenant sandbox.

## Authentication and authorization

HTTP mode supports embedded OAuth and external token introspection.

Embedded OAuth provides:

- administrator sessions stored as token hashes
- dynamic client registration with HTTPS or loopback redirect validation
- authorization-code flow with PKCE S256
- explicit consent with persisted grants
- CSRF-bound, session-bound, expiring, single-use authorization requests
- single-use authorization codes
- rotating, single-use refresh tokens

Code consumption and refresh rotation use conditional database updates inside SQLite transactions. A replay returns `invalid_grant`.

External introspection accepts only active tokens whose `aud` or `resource` matches the complete MCP URL. A response without either claim is rejected.

HTTP tools require scopes:

- `codem:read` for system information, repository discovery, workspace reads, and GitHub status
- `codem:workspace` for persistent clone/update operations
- `codem:execute` for terminal execution

Embedded OAuth cannot grant `codem:execute` in this release.

## HTTP controls

- Public URLs require HTTPS outside localhost.
- `CODEM_PUBLIC_URL` must be a root origin; unsupported base paths fail at startup.
- Requests must use an allowed `Host` value.
- Protected-resource metadata and Bearer challenges identify the exact MCP resource.
- OAuth redirects accept HTTPS and loopback HTTP only.
- Authentication and consent responses use `Cache-Control: no-store`.
- Consent HTML applies a restrictive content security policy and `X-Content-Type-Options: nosniff`.
- Outbound OAuth and GitHub requests have bounded deadlines.

The deployment proxy must preserve the original Host header, terminate HTTPS securely, enforce reasonable body/rate limits, and avoid logging bootstrap or OAuth secrets.

## Setup token

`CODEM_SETUP_TOKEN` gates the initial `/setup` route. It is independent from `CODEM_SECRET_KEY`.

The browser bootstrap query is sensitive because URLs may be retained by browser history, reverse proxies, analytics, screenshots, or chat logs. Use it only over HTTPS, complete setup promptly, then remove or rotate the token.

## Secret handling

- Passwords are hashed with Argon2id.
- Sessions, OAuth codes, access tokens, refresh tokens, setup states, and CSRF/request tokens are stored as hashes where verification does not require plaintext.
- GitHub App configuration stored in SQLite is encrypted with `CODEM_SECRET_KEY`.
- GitHub private keys, installation tokens, OAuth client secrets, and access tokens are never returned by MCP tools. Git installation tokens are passed only through an ephemeral askpass environment and are excluded from command arguments, remotes, SQLite, and safe errors.
- The process adapter receives a small environment allowlist rather than the full server environment.
- Safe error responses omit remote response bodies and credentials.

Backups are credential-bearing data. Protect the database and `CODEM_SECRET_KEY` separately and with equivalent access controls.

## Workspace boundary

Local stdio paths are resolved against the configured root. In HTTP mode, clients select an opaque `workspaceId`; CodeM resolves it through an owner-scoped SQLite row and verifies the checkout remains under `CODEM_WORKSPACES_DIR`. Existing symlinks are canonicalized before access, and traversal or symlink escape is rejected.

Repository names and refs are validated before Git runs. Opaque workspace IDs, not repository input, determine checkout paths. Dirty workspaces are never fetched, reset, cleaned, or overwritten. The public read tool supports bounded UTF-8 regular files and rejects binary content.

## Process execution

The terminal contract separates executable and argument arrays; CodeM does not pass an opaque shell string. Execution applies:

- workspace-bound working directory
- reduced environment
- stdin byte limit
- stdout and stderr byte limits
- maximum wall-clock timeout
- cancellation handling
- detached POSIX process groups when supported
- `SIGTERM` followed by `SIGKILL` after a bounded grace period

Remote terminal is disabled unless `CODEM_ALLOW_REMOTE_TERMINAL=true`, and embedded OAuth still cannot authorize it. These controls limit execution but do not safely isolate mutually untrusted tenants. A dedicated sandbox executor is required before enabling broad remote execution.

## SQLite and concurrency

SQLite is supported for one writable CodeM replica. Sharing one database across multiple application replicas is outside the security and consistency model.

Authorization-code consumption and refresh rotation are atomic at the database boundary, but horizontal scaling requires a future shared database adapter and broader distributed-state review.

## Threats addressed

### Path traversal and symlink escape

Canonical workspace resolution prevents a client from selecting arbitrary host paths through `..`, absolute paths, or existing symlinks.

### Command injection

Executable and arguments remain separate. Shell metacharacters in an argument are not interpreted by a shell.

### Token replay

Pending consent requests, authorization codes, and refresh tokens are single-use. PKCE binds an authorization code to the verifier held by the client.

### Token substitution

External tokens require an audience/resource matching the MCP URL. Embedded access tokens carry the same resource and are checked on every MCP request.

### Resource exhaustion

Terminal execution, output, stdin, and outbound network requests are bounded. Deployment-level request size, rate, CPU, memory, and concurrency controls remain the operator's responsibility.

### Secret leakage

Secrets stay in server-side storage and are omitted from MCP results. Operators must also configure proxy logs, backups, error collection, and container access appropriately.

## Known gaps

The following controls are not complete:

- hardened per-job sandboxing
- application-level rate limiting and request-size middleware
- full audit-event persistence
- multi-user role and tenant isolation
- automated secret rotation
- production PostgreSQL adapter and multi-replica coordination
- artifact persistence and redaction pipeline

Treat these as prerequisites for a public, multi-tenant remote coding service.

## Security tests

The repository currently covers workspace traversal, owner isolation, persistent lifecycle transitions, dirty-workspace refusal, Git credential redaction, output truncation, timeout/cancellation, process escalation, stdin limits, HTTP host and OAuth redirect validation, authentication challenges, introspection audience enforcement, consent CSRF, single-use authorization codes, refresh rotation, and GitHub/OAuth timeout errors.
