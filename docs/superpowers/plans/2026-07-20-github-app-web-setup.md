# GitHub App Web Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a secure browser-based GitHub App Manifest and installation flow while retaining environment-based GitHub configuration as the preferred override.

**Architecture:** Add focused crypto/storage/provider/controller modules. The HTTP handler mounts the controller beside embedded OAuth; runtime GitHub calls resolve environment configuration first, then encrypted SQLite configuration. Existing `GitHubAppClient` remains responsible for App JWT signing and memory-only installation-token caching.

**Tech Stack:** Bun 1.3.3, TypeScript strict mode, `bun:sqlite`, Node crypto AES-256-GCM/HKDF, GitHub App Manifest API, Bun test.

## Global Constraints

- Support one active GitHub App and one installation.
- Environment configuration takes precedence when complete.
- Encrypt private key, client secret, and webhook secret using `CODEM_SECRET_KEY`.
- Never expose GitHub credentials or installation tokens in HTML, logs, or MCP responses.
- All setup mutations require an authenticated administrator session and CSRF protection.
- Callback state is random, session-bound, expiring, single-use, and stored only as a hash.
- Failed callbacks must not replace a previously valid configuration.

---

### Task 1: Persistent encrypted GitHub configuration

**Files:**
- Create: `apps/mcp-server/src/github/secret-box.ts`
- Create: `apps/mcp-server/src/github/github-config-store.ts`
- Modify: `apps/mcp-server/src/storage/sqlite.ts`
- Test: `apps/mcp-server/src/github/secret-box.test.ts`
- Test: `apps/mcp-server/src/github/github-config-store.test.ts`

**Interfaces:**
- Produces: `SecretBox.encrypt(value): string`, `SecretBox.decrypt(value): string`.
- Produces: `GitHubConfigStore.load()`, `saveAppCredentials()`, `saveInstallation()`, `disconnect()`, and setup-state lifecycle methods.

- [ ] Write failing tests for encryption round-trip, tamper rejection, encrypted persistence, state expiry, session binding, and single use.
- [ ] Run `bun test apps/mcp-server/src/github/secret-box.test.ts apps/mcp-server/src/github/github-config-store.test.ts` and confirm failures.
- [ ] Add SQLite tables for encrypted credentials, installation metadata, and setup states.
- [ ] Implement AES-256-GCM encryption with an HKDF-derived key from `CODEM_SECRET_KEY`.
- [ ] Implement transactional store operations without returning plaintext secrets from status methods.
- [ ] Re-run the focused tests and confirm they pass.
- [ ] Commit with `feat: persist encrypted GitHub App configuration`.

### Task 2: Runtime configuration provider

**Files:**
- Create: `apps/mcp-server/src/github/github-provider.ts`
- Modify: `apps/mcp-server/src/main.ts`
- Modify: `apps/mcp-server/src/create-server.ts`
- Test: `apps/mcp-server/src/github/github-provider.test.ts`

**Interfaces:**
- Consumes: `GitHubConfigStore.load()`.
- Produces: `DatabaseBackedGitHubProvider.getConnectionStatus()` and `invalidate()`.

- [ ] Write failing tests for environment precedence, database fallback, disconnected status, and cache invalidation.
- [ ] Run the focused test and verify failure.
- [ ] Implement provider resolution and reuse `GitHubAppClient` per configuration fingerprint.
- [ ] Wire the provider into application startup instead of constructing a startup-only client.
- [ ] Re-run tests and commit with `feat: resolve GitHub App configuration at runtime`.

### Task 3: Authenticated GitHub setup controller

**Files:**
- Create: `apps/mcp-server/src/github/github-setup-controller.ts`
- Modify: `apps/mcp-server/src/auth/embedded.ts`
- Modify: `apps/mcp-server/src/http-server.ts`
- Test: `apps/mcp-server/src/github/github-setup-controller.test.ts`

**Interfaces:**
- Consumes: admin session lookup, `GitHubConfigStore`, provider invalidation, public URL.
- Produces routes under `/setup/github` for status, manifest start/callback, install callback, test, and disconnect.

- [ ] Expose a reusable authenticated-session lookup from embedded auth.
- [ ] Write failing tests for admin enforcement, CSRF rejection, manifest payload/redirect, callback-state rejection, successful credential exchange, installation validation, and disconnect.
- [ ] Run the focused test and verify failure.
- [ ] Implement HTML escaping, CSRF tokens, GitHub Manifest exchange, staged credential validation, installation callback, test, and disconnect.
- [ ] Mount the controller before the `/mcp` route.
- [ ] Re-run focused tests and commit with `feat: add GitHub App web setup flow`.

### Task 4: Regression verification and documentation

**Files:**
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `docs/security-model.md`
- Modify: `apps/mcp-server/src/config.test.ts`
- Modify: existing HTTP/auth tests as needed.

- [ ] Document `CODEM_SECRET_KEY`, web setup URLs, environment precedence, and disconnect semantics.
- [ ] Add regression tests covering embedded OAuth and authenticated `/mcp` requests with the setup controller mounted.
- [ ] Run `bun run format:check`, `bun run lint`, `bun run typecheck`, and `bun test`.
- [ ] Fix only failures caused by this feature and repeat all checks until clean.
- [ ] Commit with `docs: document GitHub App web setup`.
