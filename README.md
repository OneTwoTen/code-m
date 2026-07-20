# CodeM

CodeM is an MCP server for coding agents. It exposes focused tools for inspecting projects, reading and changing files, running terminal commands, interacting with Git, and executing quality checks.

The project is designed as a host-agnostic coding tool engine. MCP is the primary protocol adapter; ChatGPT Apps SDK integration is optional and isolated from the core.

## Technology direction

- TypeScript with strict mode
- Bun as runtime, package manager, workspace manager, script runner, and initial test runner
- MCP TypeScript SDK v1.x
- Zod for tool input and output contracts
- Biome for formatting and linting
- `Bun.spawn` behind a `ProcessRunner` port
- `stdio` transport for local coding agents
- Streamable HTTP transport for remote clients and ChatGPT
- Container-backed execution for untrusted or remote terminal workloads

## Architecture principles

1. Core project and execution logic must not depend on ChatGPT or Bun-specific APIs.
2. MCP handlers remain thin and delegate to application services.
3. Every public tool performs one clear operation.
4. Read, write, and execute capabilities are separated and authorized independently.
5. Terminal execution is bounded by workspace, timeout, output, environment, and command policies.
6. Large outputs are stored as resources or artifacts instead of being returned inline.
7. The MVP is a modular monolith; distributed executors are introduced only when scaling requires them.

## Proposed repository layout

```text
code-m/
├── apps/
│   ├── mcp-server/
│   └── web/                       # optional ChatGPT widgets
├── packages/
│   ├── core/
│   ├── tool-contracts/
│   ├── tools/
│   ├── policy/
│   ├── adapters/
│   ├── host-openai/
│   ├── observability/
│   └── testkit/
├── tests/
│   ├── contract/
│   ├── integration/
│   ├── e2e/
│   └── security/
└── docs/
```

## Documentation

- [Architecture](docs/architecture.md)
- [Tool catalog](docs/tool-catalog.md)
- [Terminal executor](docs/terminal-executor.md)
- [Security model](docs/security-model.md)
- [Delivery roadmap](docs/roadmap.md)
- [ADR 0001: Bun and TypeScript](docs/adr/0001-bun-typescript.md)
- [ADR 0002: Modular monolith](docs/adr/0002-modular-monolith.md)

## Initial delivery target

The first usable release should provide:

- project inspection
- bounded file listing and reading
- text search
- patch application
- Git status and diff
- non-interactive terminal execution
- test and lint wrappers
- `stdio` and Streamable HTTP transports
- contract, integration, security, and end-to-end tests

Interactive PTY sessions, widgets, OAuth, and distributed execution are later phases.