# Issue 4 Repository Workspaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let authenticated MCP clients list GitHub App-authorized repositories, open persistent repository workspaces, and select those workspaces by stable `workspaceId` without operator-managed clones.

**Architecture:** Extend the GitHub provider for paginated repository access and short-lived credential execution. Add a workspace store interface with SQLite implementation, a credential-safe Git process transport, and a repository workspace service that owns lifecycle, locking, root resolution, and safe errors. MCP handlers remain thin adapters and stdio keeps its configured root fallback.

**Tech Stack:** Bun 1.3.3, TypeScript strict mode, `bun:sqlite`, MCP TypeScript SDK 1.29.0, Zod 4.4.3, Biome 2.5.4, system Git executable.

## Global Constraints

- `repository.list` requires `codem:read` and returns only application repository metadata.
- `workspace.open_repository` requires `codem:workspace`; embedded OAuth continues to reject `codem:execute`.
- HTTP workspace operations require `authInfo.extra.subject` and scope every row lookup by that subject.
- `CODEM_WORKSPACES_DIR` defaults to `${CODEM_DATA_DIR}/workspaces`.
- Checkouts live only at `${CODEM_WORKSPACES_DIR}/ws_<opaque-id>/repository`.
- Installation tokens must never appear in SQLite, Git config/remotes, command arguments, MCP results, logs, or returned errors.
- Dirty workspaces are never fetched, reset, cleaned, or overwritten.
- Existing traversal and symlink protections remain authoritative after resolving a workspace root.
- Every behavior change follows RED → GREEN → REFACTOR; final verification is `bun run check` plus Docker build and GitHub Actions.

---

### Task 1: Workspace configuration, migration, and store boundary

**Files:**
- Modify: `apps/mcp-server/src/config.test.ts`
- Modify: `apps/mcp-server/src/config.ts`
- Modify: `apps/mcp-server/src/storage/sqlite.ts`
- Create: `apps/mcp-server/src/workspace/workspace-store.ts`
- Create: `apps/mcp-server/src/storage/sqlite-workspace-store.ts`
- Create: `apps/mcp-server/src/storage/sqlite-workspace-store.test.ts`

**Interfaces:**
- Produces: `WorkspaceRecord`, `WorkspaceStatus`, `CreateWorkspaceInput`, and `WorkspaceStore`.
- Produces: `SQLiteWorkspaceStore` implementing owner-scoped create/find/get/update operations.
- `CodeMHttpConfig` gains `workspacesDir: string`.

- [ ] Add failing config tests for the `${CODEM_DATA_DIR}/workspaces` default and explicit `CODEM_WORKSPACES_DIR` override.
- [ ] Add failing SQLite tests that reopen the database, preserve a workspace row, scope `workspaceId` lookup by user, and update status/error/open timestamps.
- [ ] Run `bun test apps/mcp-server/src/config.test.ts apps/mcp-server/src/storage/sqlite-workspace-store.test.ts`; expect missing config/store failures.
- [ ] Add migration version 4 that rebuilds the MVP `workspaces` table with `repository_full_name`, `checkout_path`, lifecycle timestamps, `last_error`, and status checks while preserving old rows.
- [ ] Implement prepared SQLite queries behind `WorkspaceStore`; never expose the raw `Database` to workspace services.
- [ ] Run focused tests and `bun run typecheck`.
- [ ] Commit as `feat: add persistent workspace store`.

### Task 2: GitHub repository discovery and internal token boundary

**Files:**
- Modify: `apps/mcp-server/src/github/github-app.test.ts`
- Modify: `apps/mcp-server/src/github/github-app.ts`
- Modify: `apps/mcp-server/src/github/github-provider.ts`

**Interfaces:**
- Produces: `GitHubRepository`, `RepositoryPage`, and `RepositoryListInput`.
- `GitHubRepositoryProvider` exposes `listRepositories`, `getRepository`, and `withInstallationToken` in addition to connection status.
- Cursors are opaque base64url page tokens and limits are bounded to 1–100.

- [ ] Add failing tests for page 1/page 2 results, invalid cursors, repository lookup, timeout/authentication mapping, and absence of token/clone URL in public list results.
- [ ] Run `bun test apps/mcp-server/src/github/github-app.test.ts`; expect missing repository APIs.
- [ ] Refactor installation token acquisition so repository calls share the cache but only `withInstallationToken` can hand the raw token to an internal callback.
- [ ] Implement paginated `/installation/repositories` requests and authenticated `/repos/{owner}/{repo}` lookup with safe status mapping.
- [ ] Extend `DatabaseBackedGitHubProvider` while preserving configuration fingerprint invalidation.
- [ ] Run focused tests and typecheck.
- [ ] Commit as `feat: add GitHub repository discovery`.

### Task 3: Credential-safe Git process transport

**Files:**
- Create: `apps/mcp-server/src/workspace/git-transport.ts`
- Create: `apps/mcp-server/src/workspace/process-git-transport.ts`
- Create: `apps/mcp-server/src/workspace/process-git-transport.test.ts`

**Interfaces:**
- Produces: `GitTransport` with `clone`, `isDirty`, `fetch`, and `checkoutRef` operations.
- Produces: `ProcessGitTransport(processRunner, options?)`.
- Git network methods accept a credential object internally; local status/checkout methods do not.

- [ ] Add failing tests with a recording `ProcessRunner` proving tokens appear only in the child environment, clone URLs/arguments stay credential-free, askpass directories are removed, and returned failures redact tokens and credential URLs.
- [ ] Add failing tests for non-zero status/fetch/checkout results mapping to safe transport errors and cancellation propagation.
- [ ] Run `bun test apps/mcp-server/src/workspace/process-git-transport.test.ts`; expect missing transport failures.
- [ ] Implement a private temporary askpass script with mode `0700`, `GIT_TERMINAL_PROMPT=0`, bounded output, timeout, and `finally` cleanup.
- [ ] Implement detached ref resolution in priority order: remote branch, tag, then arbitrary commit object; reject unresolved refs without echoing raw stderr.
- [ ] Run focused tests and typecheck.
- [ ] Commit as `feat: add credential-safe Git transport`.

### Task 4: Repository workspace lifecycle and root resolution

**Files:**
- Create: `apps/mcp-server/src/workspace/repository-workspace-service.ts`
- Create: `apps/mcp-server/src/workspace/repository-workspace-service.test.ts`

**Interfaces:**
- Produces: `RepositoryWorkspaceService.openRepository(input, signal)`.
- Produces: `RepositoryWorkspaceService.resolveWorkspaceRoot(userId, workspaceId)`.
- Produces: stable validation helpers for canonical repository names and refs.

- [ ] Add failing tests for default branch, explicit branch/tag/commit, stable reuse, dirty refusal, failed clone cleanup/retry, owner isolation, path containment, and sanitized lifecycle errors.
- [ ] Add a concurrency test that starts two opens for the same user/repository/ref and proves the second operation enters Git only after the first releases the keyed lock.
- [ ] Run `bun test apps/mcp-server/src/workspace/repository-workspace-service.test.ts`; expect missing service failures.
- [ ] Implement canonical input validation and opaque `ws_<id>` generation.
- [ ] Implement service-owned directory creation/removal and `creating → ready`, `updating → ready`, and `failed` transitions.
- [ ] Refuse dirty workspaces before any fetch or checkout operation.
- [ ] Resolve only ready owner-scoped workspace IDs and verify the stored checkout remains beneath `CODEM_WORKSPACES_DIR`.
- [ ] Run focused tests and typecheck.
- [ ] Commit as `feat: manage persistent repository workspaces`.

### Task 5: MCP tools, scopes, and workspace-aware reads

**Files:**
- Modify: `apps/mcp-server/src/config.test.ts`
- Modify: `apps/mcp-server/src/config.ts`
- Modify: `apps/mcp-server/src/create-server.ts`
- Modify: `apps/mcp-server/src/http-server.ts`
- Modify: `apps/mcp-server/src/main.ts`
- Modify: `apps/mcp-server/src/tool-handlers.ts`
- Modify: `apps/mcp-server/src/tool-handlers.test.ts`
- Modify: `tests/e2e/stdio.test.ts`

**Interfaces:**
- Registers `repository.list({ cursor?, limit? })`.
- Registers `workspace.open_repository({ repository, ref? })`.
- Extends `workspace.read_file({ workspaceId?, path, maxBytes? })`.
- Embedded auth defaults to `codem:read codem:workspace`.

- [ ] Add failing server/tool tests for scope enforcement, safe serialized results, missing subject rejection, and workspace-ID root resolution.
- [ ] Add traversal and symlink escape tests using a workspace-ID-resolved root.
- [ ] Run focused server, handler, config, and stdio tests; expect missing tools/scope/root resolver failures.
- [ ] Compose `SQLiteWorkspaceStore`, `ProcessGitTransport`, and `RepositoryWorkspaceService` only in HTTP mode.
- [ ] Require `workspaceId` for remote reads while preserving stdio root fallback when omitted.
- [ ] Update `system.info` capabilities based on constructed dependencies.
- [ ] Run focused tests and typecheck.
- [ ] Commit as `feat: expose repository workspace MCP tools`.

### Task 6: HTTP MCP end-to-end repository flow

**Files:**
- Modify: `tests/e2e/http.test.ts`

**Interfaces:**
- Exercises embedded OAuth and the real MCP HTTP handler with fake GitHub API/Git transport boundaries and real SQLite/filesystem state.

- [ ] Add a failing end-to-end test that registers a client, creates/logs in a user, grants `codem:read codem:workspace`, obtains a token, calls `repository.list`, opens a repository, receives `workspaceId`, and reads `README.md` through that workspace.
- [ ] Assert the response stream, database, checkout path, origin metadata, and captured command arguments contain no installation token or credential URL.
- [ ] Run `bun test tests/e2e/http.test.ts`; fix only defects exposed by the flow.
- [ ] Commit as `test: cover repository workspace HTTP flow`.

### Task 7: Operations and security documentation

**Files:**
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/backup-and-restore.md`
- Modify: `docs/deployment.md`
- Modify: `docs/security-model.md`
- Modify: `docs/tool-catalog.md`
- Modify: `docs/roadmap.md`

**Interfaces:**
- Documents `/data/workspaces`, `CODEM_WORKSPACES_DIR`, the `codem:workspace` consent scope, tool schemas, backup/restore, dirty-workspace behavior, and single-replica locking.

- [ ] Update the HTTP quick start to remove the manual `/workspace` bind mount for GitHub-backed usage.
- [ ] Document that workspace checkouts may contain uncommitted changes and must be backed up and protected with SQLite.
- [ ] Document credential handling, safe errors, no destructive dirty reset, and the multi-replica limitation.
- [ ] Mark repository discovery/persistent checkout complete in the roadmap and leave `workspace.list` as a follow-up.
- [ ] Run Biome formatting and inspect internal links.
- [ ] Commit as `docs: document persistent repository workspaces`.

### Task 8: Final verification and pull request

**Files:**
- Create: pull request from `feat/issue-4-repository-workspaces` to `main`.

- [ ] Run `bun install --frozen-lockfile`.
- [ ] Run `bun run format:check`.
- [ ] Run `bun run lint`.
- [ ] Run `bun run typecheck`.
- [ ] Run `bun run test`.
- [ ] Run `docker build --tag codem-mcp:issue-4 .`.
- [ ] Confirm GitHub Actions is green for the branch head.
- [ ] Open a PR linking issue #4 with architecture, credential-safety, dirty-workspace, migration, and verification notes.
