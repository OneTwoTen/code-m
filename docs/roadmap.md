# CodeM Delivery Roadmap

## MVP objective

Prove that CodeM can run as a real MCP server, expose useful coding tools, enforce basic workspace and process policies, and be exercised automatically in CI.

The MVP is intentionally narrow. It is a feasibility release, not a production-ready remote coding platform.

## MVP acceptance criteria

1. `bun install` succeeds from a clean checkout.
2. `bun run check` runs Biome, TypeScript type checking, and tests.
3. The stdio MCP server starts without writing protocol-breaking logs to stdout.
4. An MCP client can list and call `system.info`.
5. An MCP client can call `workspace.read_file` within the configured workspace.
6. Paths outside the workspace are rejected.
7. An MCP client can call `terminal.exec` with executable and argument arrays.
8. `terminal.exec` enforces workspace-relative `cwd`, timeout, and output limits.
9. Tool-level failures return safe MCP error results.
10. CI verifies formatting, linting, types, and tests.

## MVP scope

### Included

- Bun workspace and scripts
- TypeScript strict mode
- Biome formatting and linting
- MCP stdio transport
- `system.info`
- `workspace.read_file`
- `terminal.exec`
- workspace-boundary policy
- bounded process output
- timeout handling
- unit and integration tests
- GitHub Actions CI

### Excluded

- Streamable HTTP
- authentication and OAuth
- ChatGPT widgets
- persistent terminal or PTY sessions
- container sandbox implementation
- Git write tools
- patch application
- distributed jobs
- artifact persistence
- semantic code indexing

These exclusions prevent the feasibility release from becoming a premature platform build.

## Phase 1: repository skeleton

- root Bun workspace
- shared TypeScript configuration
- Biome configuration
- MCP server package
- core package
- adapter package
- test scripts and CI

Deliverable: the repository installs, formats, type-checks, and tests.

## Phase 2: vertical MCP slice

- create MCP server
- register `system.info`
- connect over stdio
- add a smoke test using an in-memory or stdio client where practical

Deliverable: a client can discover and call a real tool.

## Phase 3: workspace read capability

- execution context with authorized workspace root
- canonical path resolver
- `workspace.read_file`
- traversal and not-found tests

Deliverable: useful coding-agent read access with a tested boundary.

## Phase 4: terminal feasibility

- `ProcessRunner` port
- `BunProcessRunner`
- `terminal.exec`
- timeout and output limits
- policy tests for invalid `cwd`

Deliverable: a coding agent can run `bun --version`, project tests, or similar non-interactive commands without receiving an unrestricted shell string.

## Phase 5: hardening before remote transport

- container-backed executor
- artifacts for large output
- process-tree termination
- authentication and authorization
- audit persistence
- rate limiting
- Streamable HTTP

Deliverable: a remotely deployable service boundary.

## Post-MVP tool sequence

1. `workspace.list_files`
2. `workspace.search_text`
3. `workspace.apply_patch`
4. `git.status`
5. `git.diff`
6. `quality.test`
7. `quality.lint`
8. `project.inspect`

This order builds a complete read-change-verify loop before introducing Git mutation or interactive terminals.