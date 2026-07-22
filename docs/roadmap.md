# CodeM delivery roadmap

## Current release objective

CodeM now proves both local and self-hosted remote MCP workflows:

- a real MCP server over stdio and Streamable HTTP
- bounded workspace reads and non-interactive process execution
- embedded OAuth or external token introspection
- SQLite persistence and startup migrations
- server-side GitHub App setup, repository discovery, and persistent checkouts
- one-container deployment with a persistent `/data` volume
- automated unit, integration, HTTP, stdio, and Docker verification

The supported production shape remains a single-operator, single-replica service. It is not yet a public multi-tenant coding platform.

## Delivered foundation

### Repository and protocol

- Bun 1.3.3 workspace
- TypeScript strict mode
- Biome formatting and linting
- MCP TypeScript SDK
- stdio and Streamable HTTP transports
- canonical application metadata
- health and OAuth protected-resource metadata

### Current tools

- `system.info`
- `repository.list`
- `workspace.open_repository`
- `workspace.read_file`
- `github.connection_status`
- `terminal.exec`

### Workspace and process policy

- canonical workspace-boundary resolution
- executable and argument separation
- reduced process environment
- stdin and stdout/stderr byte limits
- timeout and cancellation
- process-group termination with TERM-to-KILL escalation
- remote terminal disabled by default

### Remote authentication hardening

- embedded administrator sessions
- dynamic OAuth client registration
- explicit consent and persisted grants
- CSRF/session-bound pending authorization requests
- PKCE authorization codes
- atomic, single-use code exchange
- atomic refresh-token rotation
- external introspection with required audience/resource
- outbound request deadlines
- host and redirect validation

### Persistence and operations

- SQLite WAL mode and ordered migrations
- application-facing OAuth storage interface
- encrypted server-side GitHub settings
- owner-scoped persistent workspace metadata and `/data/workspaces` checkouts
- credential-safe Git clone/fetch and dirty-workspace protection
- one-container deployment guide
- backup and restore runbook
- HTTP/OAuth/GitHub integration coverage

## Next: complete the safe read-change-verify loop

Recommended tool sequence:

1. `workspace.list_files`
2. `workspace.search_text`
3. `workspace.apply_patch`
4. `git.status`
5. `git.diff`
6. `quality.test`
7. `quality.lint`
8. `project.inspect`

This sequence gives an agent focused inspection, controlled mutation, and verification before Git mutation or interactive terminal features are expanded.

## Next: remote execution isolation

Before broadly enabling `terminal.exec` over HTTP:

- implement a dedicated container or microVM executor
- set CPU, memory, process, filesystem, and network quotas
- separate each job/workspace identity
- enforce command policy and approvals
- persist audit events
- add concurrency and queue controls
- test cleanup of descendant and detached processes across platforms

The current local process limits are defense in depth, not the final sandbox boundary.

## Next: production service controls

- application-level rate limiting
- request-size limits
- structured security/audit events
- metrics and tracing
- secret-rotation procedures
- session and grant administration UI
- OAuth revocation and administrator logout-all controls
- proxy deployment tests

## Next: shared persistence and scaling

SQLite remains the default for one writable replica. Horizontal scaling requires:

- a production PostgreSQL adapter for the existing storage contracts
- shared session, grant, token, GitHub, and migration state
- transaction/concurrency tests against PostgreSQL
- deployment locking and migration coordination
- backup/restore guidance for the new adapter

PostgreSQL is an extension point, not a delivered feature in the current release.

## Later platform capabilities

- persistent artifacts and large-output references
- background jobs and cancellation
- workspace listing, lifecycle administration, and advanced worktree management
- Git mutation tools and approval flows
- project indexing and semantic search
- organization/tenant policy
- optional ChatGPT Apps SDK UI resources and widgets
- interactive PTY sessions after isolation and approval controls

## Release gates for a public multi-tenant service

A public service should not launch until all of these are demonstrated:

1. isolated execution per tenant/job
2. rate and request-size limits
3. durable audit events
4. shared production database
5. secret and credential rotation
6. tenant-scoped authorization and ownership checks
7. backup, restore, and disaster-recovery exercises
8. adversarial security tests for OAuth, workspace, process, and repository content
