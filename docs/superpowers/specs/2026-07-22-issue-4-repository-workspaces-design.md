# Issue 4 Repository Workspaces Design

## Context

CodeM can currently prove that a configured GitHub App installation is reachable, but the MCP client cannot discover repositories as an application resource or open one as a persistent workspace. The server still resolves every workspace-bound tool against a single operator-provided `CODEM_WORKSPACE_ROOT`.

Issue #4 adds a self-service remote flow:

```text
Connect GitHub App
  → repository.list
  → workspace.open_repository
  → receive workspaceId
  → use workspace tools with workspaceId
```

The implementation must preserve local stdio behavior, persist repository checkouts under `/data`, isolate workspace ownership by authenticated subject, and keep installation credentials out of responses, logs, remotes, command arguments, and database rows.

## Considered approaches

### 1. Put GitHub, Git, and SQLite logic directly in MCP tool handlers

The tool handlers would list repositories, spawn `git`, and issue SQL statements themselves.

**Trade-off:** fewer files initially, but credentials and persistence concerns become coupled to protocol code, tests require broad mocks, and future storage or Git transport changes become risky.

### 2. Add focused repository, workspace, store, and Git transport boundaries — selected

Keep the Bun/TypeScript modular monolith. Extend the existing GitHub provider with repository discovery and short-lived credential execution, add an application-facing `WorkspaceStore`, implement a repository workspace service, and keep Git invocation behind a credential-safe transport.

**Trade-off:** introduces several small interfaces, but each security boundary can be tested independently and tool handlers remain protocol adapters.

### 3. Add a background worker or external clone service

Repository operations would be queued to another process or service.

**Trade-off:** supports multi-replica coordination later, but adds deployment and failure complexity that is explicitly outside this issue. The selected implementation serializes operations within one CodeM process.

## Architecture

The implementation introduces four focused units:

1. **GitHub repository access** lists installation-authorized repositories, resolves repository metadata, and executes an internal callback with a short-lived installation token. Tokens never cross into MCP-facing results.
2. **Workspace store** persists workspace identity and lifecycle independently of SQLite. The SQLite adapter owns migrations and queries.
3. **Repository workspace service** validates repository/ref input, serializes opens by authenticated user/repository/ref, coordinates clone/update lifecycle, and resolves workspace roots by `workspaceId`.
4. **Git transport** performs clone, fetch, clean checks, and ref checkout. Authentication uses an ephemeral askpass helper and environment variables; persisted remotes contain only credential-free HTTPS URLs.

`apps/mcp-server` remains the composition root. Remote HTTP mode constructs the SQLite workspace store and repository workspace service. Local stdio mode continues to use the configured workspace root and does not require database-backed workspaces.

## Configuration and storage

HTTP configuration gains:

```env
CODEM_WORKSPACES_DIR=/data/workspaces
```

When unset, the value is `${CODEM_DATA_DIR}/workspaces`.

Each checkout is stored beneath an opaque server-generated identifier:

```text
${CODEM_WORKSPACES_DIR}/ws_<opaque-id>/repository
```

Repository names and refs are metadata only and are never interpolated into filesystem paths. The service verifies every generated checkout path remains beneath `CODEM_WORKSPACES_DIR`.

## Persistence model

A versioned migration replaces the unused MVP `workspaces` schema with:

```text
id
user_id
repository_full_name
ref
checkout_path
status
last_error
created_at
updated_at
last_opened_at
```

Allowed statuses are `creating`, `ready`, `updating`, and `failed`. The unique identity is `(user_id, repository_full_name, ref)`.

The migration preserves any existing rows by copying `repository → repository_full_name`, `path → checkout_path`, normalizing unknown statuses to `failed`, and setting `last_opened_at` from `updated_at`.

No installation token, private key, credential URL, or transport secret is stored in workspace metadata.

## Authentication and scopes

`repository.list` is read-only and requires `codem:read` in HTTP mode.

`workspace.open_repository` mutates server-side workspace state without granting arbitrary command execution. It requires the new `codem:workspace` scope. Embedded OAuth exposes this scope through normal explicit consent and continues to reject `codem:execute`.

The authenticated workspace owner is `authInfo.extra.subject`. Remote workspace operations reject tokens without a stable subject. Every store lookup includes `user_id`, including `workspaceId` resolution, so one user cannot access another user's checkout.

## Repository discovery

`repository.list` accepts an optional opaque cursor and a limit bounded to 1–100. The GitHub client translates the cursor to installation repository pagination and returns application concepts only:

```ts
{
  repositories: Array<{
    fullName: string;
    defaultBranch: string;
    private: boolean;
    permissions?: { pull: boolean; push: boolean };
  }>;
  nextCursor?: string;
}
```

Clone URLs and installation tokens remain internal. GitHub timeouts and authentication failures are mapped to safe stable errors.

## Repository validation and refs

Repository input must match a canonical `owner/name` form with conservative GitHub-compatible characters. Ref input must be non-empty, bounded, free of control characters, option prefixes, reflog syntax, wildcard characters, and path traversal-like components. A missing ref defaults to the repository default branch returned by GitHub.

The Git transport fetches remote refs and resolves the requested branch, tag, or commit to a commit object before checkout. Workspaces use detached HEAD at the resolved commit so reopening a clean branch workspace can safely advance to the latest fetched remote commit without preserving accidental local branch divergence.

## Git credential handling

The GitHub App client obtains an installation token only for the duration of a Git network operation. The Git transport:

- creates a private temporary askpass helper
- passes the token only through the child environment
- never places credentials in command arguments or the remote URL
- sets `GIT_TERMINAL_PROMPT=0`
- removes the helper directory in `finally`
- bounds every Git process by timeout and request cancellation
- redacts token values and credential-bearing URLs from errors

`origin` is always a credential-free HTTPS clone URL returned by GitHub repository metadata.

## Workspace lifecycle

Opening a workspace is serialized by `(userId, repository, ref)` in the CodeM process.

For a new or previously failed workspace:

1. create or reuse the metadata row with status `creating`
2. remove only the service-owned partial checkout directory
3. clone without checkout using temporary credentials
4. fetch and resolve the requested ref
5. checkout the resolved commit
6. mark the row `ready`

For a ready workspace:

1. check `git status --porcelain`
2. return `WORKSPACE_DIRTY` without fetch/reset when any tracked or untracked change exists
3. mark the row `updating`
4. fetch and resolve the ref
5. checkout the resolved commit
6. mark the row `ready`

Failures mark the row `failed` with a sanitized `last_error`. A failed clone removes the partial repository directory but retains recoverable metadata. The server continues startup regardless of individual workspace failure.

## Existing tool integration

`workspace.read_file` gains optional `workspaceId` input.

- stdio mode without `workspaceId` uses `CODEM_WORKSPACE_ROOT` exactly as before
- HTTP mode requires `workspaceId` and resolves it through the authenticated user's workspace store
- callers cannot submit an arbitrary root path
- existing lexical traversal, realpath, and symlink escape protections run after root resolution

`terminal.exec` remains unchanged in this issue and remains unavailable through embedded OAuth.

## Stable errors

The application uses stable `CodeMError` codes for:

```text
GITHUB_NOT_CONFIGURED
REPOSITORY_NOT_FOUND
REPOSITORY_ACCESS_DENIED
INVALID_REPOSITORY
INVALID_REF
WORKSPACE_BUSY
WORKSPACE_DIRTY
WORKSPACE_CREATE_FAILED
WORKSPACE_UPDATE_FAILED
WORKSPACE_NOT_FOUND
```

Messages are actionable but do not include GitHub response bodies, installation tokens, credential URLs, or raw Git stderr that may contain secrets.

## Testing

The test suite adds:

- GitHub repository pagination, lookup, timeout/authentication mapping, and token-absence assertions
- SQLite migration, persistence across reopen, owner-scoped lookup, and lifecycle updates
- repository workspace service tests for default refs, explicit refs, reuse, dirty refusal, concurrent serialization, failed clone recovery, and path containment
- Git transport tests proving credentials are absent from arguments, remotes, results, and sanitized errors
- workspace-ID read tests that rerun traversal and symlink escape coverage against resolved roots
- an HTTP MCP end-to-end flow for OAuth, repository discovery, workspace open, and `README.md` read

All changes must pass Biome formatting/linting, TypeScript strict checking, Bun tests, and the Docker build.

## Documentation and operations

README, deployment, security, backup/restore, architecture, and tool catalog documentation will describe `/data/workspaces` as persistent application data that may contain uncommitted user changes. Operators must back up and protect it alongside SQLite.

## Non-goals

- `workspace.list` in this issue; reconnect discovery can be a focused follow-up
- arbitrary remote shell execution
- destructive cleaning or resetting of dirty workspaces
- multi-replica distributed locking
- PostgreSQL workspace coordination
- automatic commit, push, pull-request creation, or repository deletion
