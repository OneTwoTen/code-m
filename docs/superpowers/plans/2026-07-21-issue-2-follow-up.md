# Issue 2 Follow-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the production-hardening work deferred from issue #2 after PR #1 while preserving the one-container SQLite-first deployment.

**Architecture:** Keep the existing Bun/TypeScript modular monolith. Add focused interfaces for application metadata, OAuth persistence, request deadlines, and process termination; implement SQLite first and test externally visible HTTP/OAuth/GitHub behavior.

**Tech Stack:** Bun 1.3.3, TypeScript strict mode, `bun:sqlite`, MCP TypeScript SDK 1.29.0, Zod 4.4.3, Biome 2.5.4.

## Global Constraints

- `CODEM_PUBLIC_URL` is the single source of truth and must be an origin URL with pathname `/`.
- SQLite remains the default production database under `/data/codem.sqlite`.
- PostgreSQL remains optional and is represented by an application-facing storage contract, not a production adapter in this PR.
- Embedded OAuth cannot grant `codem:execute` in this PR.
- Remote terminal remains disabled unless `CODEM_ALLOW_REMOTE_TERMINAL=true`.
- Secrets, OAuth tokens, GitHub installation tokens, and private keys must never appear in MCP responses or logs.
- Every behavior change follows RED → GREEN → REFACTOR and all repository checks must pass.

---

### Task 1: Application metadata and public URL policy

**Files:**
- Create: `apps/mcp-server/src/application-metadata.ts`
- Create: `apps/mcp-server/src/application-metadata.test.ts`
- Modify: `apps/mcp-server/src/config.test.ts`
- Modify: `apps/mcp-server/src/config.ts`
- Modify: `apps/mcp-server/src/create-server.ts`
- Modify: `apps/mcp-server/src/http-server.ts`
- Modify: `apps/mcp-server/src/main.ts`

**Interfaces:**
- Produces: `CODEM_APPLICATION: { name: string; version: string }`
- Produces: `runtimeVersion(): string`

- [ ] Add failing tests that package metadata is reported consistently and non-root `CODEM_PUBLIC_URL` paths are rejected.
- [ ] Run `bun test apps/mcp-server/src/application-metadata.test.ts apps/mcp-server/src/config.test.ts`; expect failures for the missing metadata module and accepted base path.
- [ ] Implement the metadata module and reject public URL paths other than `/`.
- [ ] Replace hard-coded `0.2.0` and `0.3.0` values in MCP metadata, `system.info`, health, and startup logs.
- [ ] Run the focused tests, then `bun run typecheck`.
- [ ] Commit as `feat: unify application metadata and public URL policy`.

### Task 2: Timed outbound HTTP and strict introspection audience

**Files:**
- Create: `apps/mcp-server/src/http/fetch-with-timeout.ts`
- Create: `apps/mcp-server/src/http/fetch-with-timeout.test.ts`
- Create: `apps/mcp-server/src/auth/introspection.test.ts`
- Modify: `apps/mcp-server/src/auth/introspection.ts`
- Modify: `apps/mcp-server/src/config.ts`
- Modify: `apps/mcp-server/src/http-server.ts`

**Interfaces:**
- Produces: `fetchWithTimeout(fetchFn, input, init, timeoutMs): Promise<Response>`
- `IntrospectionVerifierOptions` gains `timeoutMs?: number`.

- [ ] Add failing tests proving missing `aud/resource` is rejected and an aborted introspection request returns a safe authentication error.
- [ ] Add failing tests for the reusable timeout wrapper.
- [ ] Run focused tests; expect strict-audience and timeout failures.
- [ ] Implement the timeout wrapper with a composed abort signal and deterministic timeout error.
- [ ] Require at least one audience/resource claim and match the normalized MCP URL.
- [ ] Wire `CODEM_OUTBOUND_HTTP_TIMEOUT_MS` with a bounded default of 10 seconds.
- [ ] Run focused tests and typecheck.
- [ ] Commit as `fix: enforce token audience and outbound timeouts`.

### Task 3: SQLite OAuth store and atomic token exchange

**Files:**
- Create: `apps/mcp-server/src/auth/oauth-store.ts`
- Create: `apps/mcp-server/src/storage/sqlite-oauth-store.ts`
- Create: `apps/mcp-server/src/storage/sqlite-oauth-store.test.ts`
- Modify: `apps/mcp-server/src/storage/sqlite.ts`
- Modify: `apps/mcp-server/src/auth/embedded.ts`
- Modify: `apps/mcp-server/src/http-server.ts`
- Modify: `apps/mcp-server/src/main.ts`

**Interfaces:**
- Produces: `OAuthStore.consumeAuthorizationCode(input): IssuedTokenPair | undefined`
- Produces: `OAuthStore.rotateRefreshToken(input): IssuedTokenPair | undefined`
- Produces: `OAuthStore.hasGrant(...)`, `OAuthStore.saveGrant(...)`, and short-lived authorization request/CSRF operations.

- [ ] Add migration tables for OAuth grants and pending authorization requests.
- [ ] Add failing tests using two SQLite connections: only one code consumption succeeds and only one refresh rotation succeeds.
- [ ] Run the storage tests; expect missing interface/implementation failures.
- [ ] Implement conditional updates inside `BEGIN IMMEDIATE` transactions and insert replacement tokens in the same transaction.
- [ ] Refactor embedded auth token exchange to call the store instead of separate direct SQL statements.
- [ ] Run storage and existing SQLite tests, then typecheck.
- [ ] Commit as `feat: make OAuth token exchange atomic`.

### Task 4: Consent POST, CSRF, and persisted grants

**Files:**
- Create: `apps/mcp-server/src/auth/embedded.integration.test.ts`
- Modify: `apps/mcp-server/src/auth/embedded.ts`
- Modify: `apps/mcp-server/src/http-server.ts`

**Interfaces:**
- `GET /oauth/authorize` renders consent unless an existing grant covers the request.
- `POST /oauth/authorize` accepts `decision=allow|deny` and validates a single-use CSRF-bound authorization request.

- [ ] Add a failing integration test covering registration, setup/login, consent page, invalid CSRF, successful consent, persisted grant, one-time code exchange, and refresh rotation.
- [ ] Run the integration test; expect GET authorization to redirect immediately and POST to be unsupported.
- [ ] Implement escaped consent HTML, pending request persistence, CSRF validation, grant persistence, denial redirect, and grant reuse.
- [ ] Keep `codem:execute` rejection in the HTTP boundary.
- [ ] Run focused auth and HTTP tests.
- [ ] Commit as `feat: add embedded OAuth consent and persisted grants`.

### Task 5: GitHub API request deadlines

**Files:**
- Create: `apps/mcp-server/src/github/github-app.test.ts`
- Modify: `apps/mcp-server/src/github/github-app.ts`
- Modify: `apps/mcp-server/src/github/github-provider.ts`
- Modify: `apps/mcp-server/src/config.ts`
- Modify: `apps/mcp-server/src/main.ts`

**Interfaces:**
- `GitHubAppClient` accepts request timeout configuration while preserving injectable fetch.

- [ ] Add failing tests for installation-token and repository-list timeouts, safe status errors, and absence of token leakage.
- [ ] Run focused tests; expect hanging/uncategorized behavior.
- [ ] Use the shared timeout wrapper for every GitHub request.
- [ ] Map timeout failures to `GitHub request timed out.` without including credentials.
- [ ] Run focused tests and typecheck.
- [ ] Commit as `fix: bound GitHub API requests`.

### Task 6: Process-tree termination and execution limits

**Files:**
- Modify: `packages/core/src/process/process-runner.ts`
- Modify: `packages/adapters/src/bun-process-runner.ts`
- Modify: `packages/adapters/src/bun-process-runner.test.ts`
- Modify: `apps/mcp-server/src/tool-handlers.ts`
- Modify: `apps/mcp-server/src/tool-handlers.test.ts`

**Interfaces:**
- `ProcessExecutionRequest` gains `stdinLimitBytes` and `terminationGraceMs`.
- `BunProcessRunner` terminates the process group on POSIX, falls back to direct child kill, then escalates after the grace period.

- [ ] Add failing tests for stdin rejection, timeout escalation, cancellation, and bounded termination grace.
- [ ] Run focused tests; expect missing fields/behavior.
- [ ] Enforce stdin byte limits before spawn.
- [ ] Spawn detached on POSIX, signal the negative process-group PID, and escalate from `SIGTERM` to `SIGKILL`.
- [ ] Preserve direct child fallback and clean timers/listeners in `finally`.
- [ ] Run focused tests and typecheck.
- [ ] Commit as `fix: harden terminal process termination`.

### Task 7: HTTP/OAuth/GitHub integration coverage

**Files:**
- Create: `tests/e2e/http.test.ts`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Exercises the real Bun HTTP handler/server with SQLite and injected GitHub fetch responses.

- [ ] Add failing end-to-end coverage for health metadata, protected-resource metadata, unauthenticated MCP challenge, embedded OAuth authorization-code + PKCE flow, and GitHub connection status without credential exposure.
- [ ] Run `bun test tests/e2e/http.test.ts`; fix only production defects exposed by the test.
- [ ] Keep CI commands explicit and retain the Docker build.
- [ ] Run `bun run check` and `docker build --tag codem-mcp:issue-2 .`.
- [ ] Commit as `test: cover production HTTP OAuth and GitHub flows`.

### Task 8: Deployment, backup, scaling, and adapter documentation

**Files:**
- Modify: `.env.example`
- Modify: `README.md`
- Create: `docs/deployment.md`
- Create: `docs/backup-and-restore.md`
- Modify: `docs/architecture.md`
- Modify: `docs/security-model.md`
- Modify: `docs/roadmap.md`

**Interfaces:**
- Documents the one-container default and the `OAuthStore` boundary for future PostgreSQL support.

- [ ] Rewrite the quick start so HTTP production mode needs `CODEM_PUBLIC_URL`, `CODEM_SECRET_KEY`, `CODEM_SETUP_TOKEN`, and `/data`.
- [ ] Document SQLite WAL-safe backup and restore into an empty `/data` volume.
- [ ] Document Coolify settings, migration startup behavior, external OIDC, custom GitHub App setup, PostgreSQL/scaling limitations, and remote-terminal policy.
- [ ] Ensure examples use the canonical package version and do not expose credentials.
- [ ] Run Biome formatting and link checks by inspection.
- [ ] Commit as `docs: complete one-container deployment guidance`.

### Task 9: Final verification and PR

**Files:**
- Modify: issue #2 tracking comment if necessary.
- Create: pull request #2 from `feat/issue-2-follow-up` to `main`.

- [ ] Run `bun install --frozen-lockfile`.
- [ ] Run `bun run format:check`.
- [ ] Run `bun run lint`.
- [ ] Run `bun run typecheck`.
- [ ] Run `bun run test`.
- [ ] Run `docker build --tag codem-mcp:issue-2 .`.
- [ ] Confirm GitHub Actions is green for the branch head.
- [ ] Open PR with issue linkage, security notes, deferred non-goals, and exact verification results.
