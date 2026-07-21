# ADR 0001: Use Bun and TypeScript

- Status: Accepted
- Date: 2026-07-20

## Context

CodeM needs a runtime, package manager, workspace manager, script runner, test runner, and process API. The project also benefits from sharing schemas and types across MCP tools, server code, and optional widgets.

## Decision

Use TypeScript in strict mode and Bun for the MVP runtime, dependency installation, workspaces, scripts, and tests.

Use Biome for formatting and linting. Use Zod v4 for MCP tool schemas. Use the MCP TypeScript SDK v1 line until the next major version is stable and intentionally adopted.

Bun-specific APIs are restricted to adapters and entrypoints. Core packages use portable TypeScript and standard or Node-compatible interfaces.

## Consequences

### Positive

- one fast toolchain for install, run, test, and process execution
- first-class TypeScript execution
- simple monorepo configuration
- direct `Bun.spawn` support
- ability to share types with future UI code

### Negative

- some ecosystem libraries may assume Node behavior
- native dependencies may require explicit trusted lifecycle scripts
- runtime compatibility must be tested rather than assumed

## Guardrails

- no `Bun.*` imports in core or tool contracts
- dependency lockfile is committed
- CI runs on a pinned Bun version
- native dependencies are avoided in the MVP
- Node-compatible APIs are preferred for portable filesystem logic
