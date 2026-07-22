# PR 5 Security and Correctness Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development and execute each task in order.

**Goal:** Resolve the five blocking findings from the detailed review of PR #5 without expanding the issue #4 scope.

**Architecture:** Keep the existing GitHub provider, workspace service, store, and Git transport boundaries. Harden credential-bearing Git commands at the transport boundary, make workspace recovery non-destructive at the service boundary, and keep pagination/error normalization inside the GitHub client.

**Tech Stack:** Bun, TypeScript, bun:test, Git CLI, SQLite, GitHub Actions.

## Global Constraints

- Installation tokens must never be persisted or sent to an untrusted remote.
- Existing dirty workspaces must never be reset, cleaned, or deleted.
- Repository pagination cursors must remain correct when callers omit or change `limit`.
- GitHub authentication failures must use stable application error codes.
- Add a regression test before every production behavior change.

---

### Task 1: Harden credential-bearing Git operations

**Files:**
- Modify: `apps/mcp-server/src/workspace/process-git-transport.test.ts`
- Modify: `apps/mcp-server/src/workspace/git-transport.ts`
- Modify: `apps/mcp-server/src/workspace/process-git-transport.ts`
- Modify: `apps/mcp-server/src/workspace/repository-workspace-service.ts`

- [ ] Add tests proving configured credential helpers, URL rewrites, and checkout hooks cannot run during service-owned Git commands.
- [ ] Add tests proving fetch uses the freshly verified GitHub clone URL rather than a mutable persisted `origin` URL.
- [ ] Extend `GitFetchInput` with `cloneUrl`.
- [ ] Run credential-bearing Git commands with isolated Git config, disabled helpers, disabled hooks, and the verified URL.
- [ ] Run focused tests and commit.

### Task 2: Preserve failed-update workspaces

**Files:**
- Modify: `apps/mcp-server/src/workspace/repository-workspace-service.test.ts`
- Modify: `apps/mcp-server/src/workspace/repository-workspace-service.ts`

- [ ] Add a regression test that makes an update fail, adds a local change, retries open, and expects `WORKSPACE_DIRTY` with files preserved.
- [ ] Recover an existing failed checkout through the update path when it is a valid checkout; only recreate when no checkout exists.
- [ ] Run focused tests and commit.

### Task 3: Make repository cursors self-contained

**Files:**
- Modify: `apps/mcp-server/src/github/github-app.test.ts`
- Modify: `apps/mcp-server/src/github/github-app.ts`

- [ ] Add tests that omit or change `limit` after receiving a cursor.
- [ ] Encode both page and page size in the opaque cursor and reject conflicting explicit limits.
- [ ] Add token-endpoint authentication failure tests.
- [ ] Normalize token request authentication failures to `REPOSITORY_ACCESS_DENIED`.
- [ ] Run focused tests and commit.

### Task 4: Verify the complete PR

- [ ] Run `bun install --frozen-lockfile`.
- [ ] Run `bun run format:check`.
- [ ] Run `bun run lint`.
- [ ] Run `bun run typecheck`.
- [ ] Run `bun run test`.
- [ ] Run `docker build --tag codem-mcp:ci .`.
- [ ] Confirm GitHub Actions succeeds on the final head commit.
