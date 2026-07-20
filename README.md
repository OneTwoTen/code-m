# CodeM

CodeM is an MCP server for coding agents. The current MVP proves a complete local workflow over stdio: discover tools, read a file inside an authorized workspace, and execute a bounded non-interactive process.

## MVP stack

- TypeScript with strict mode
- Bun as runtime, package manager, workspace manager, and test runner
- MCP TypeScript SDK v1.x
- Zod for tool schemas
- Biome as the only formatter and linter
- `Bun.spawn` behind a portable `ProcessRunner` interface
- MCP stdio transport

## Available MVP tools

| Tool | Purpose | Effect |
|---|---|---|
| `system.info` | Report CodeM version, runtime, workspace, and capabilities | Read-only |
| `workspace.read_file` | Read a bounded UTF-8 file inside the workspace | Read-only |
| `terminal.exec` | Run one executable with a separate argument array | Execute; may change files |

`terminal.exec` does not accept an opaque shell string. It enforces a workspace-relative working directory, timeout, output limits, and a reduced environment.

## Requirements

- Bun 1.3.3

## Install

```bash
bun install
```

The first install creates `bun.lock`. Commit that lockfile before merging changes that add or update dependencies.

## Verify

```bash
bun run check
```

This runs:

```text
Biome format check
Biome lint
TypeScript typecheck
Bun tests, including an MCP stdio end-to-end test
```

To apply formatting:

```bash
bun run format
```

## Run the MCP server

CodeM authorizes one workspace root. Set it explicitly when the MCP client is started from another directory:

```bash
CODEM_WORKSPACE_ROOT=/absolute/path/to/project bun run dev
```

The server communicates on stdout using MCP JSON-RPC. Diagnostics are written only to stderr.

## Example MCP client configuration

```json
{
  "mcpServers": {
    "code-m": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/code-m/apps/mcp-server/src/main.ts"],
      "env": {
        "CODEM_WORKSPACE_ROOT": "/absolute/path/to/project"
      }
    }
  }
}
```

Use absolute paths in host configuration. Tool arguments such as `path` and `cwd` remain relative to `CODEM_WORKSPACE_ROOT`.

## Repository layout

```text
code-m/
├── apps/
│   └── mcp-server/              # MCP composition root and tools
├── packages/
│   ├── core/                    # portable contracts and workspace policy
│   └── adapters/                # Bun process adapter
├── tests/
│   └── e2e/                     # real stdio client/server test
└── docs/
    ├── architecture.md
    ├── tool-catalog.md
    ├── terminal-executor.md
    ├── security-model.md
    ├── roadmap.md
    ├── adr/
    └── superpowers/plans/
```

## Documentation

- [Architecture](docs/architecture.md)
- [Tool catalog](docs/tool-catalog.md)
- [Terminal executor](docs/terminal-executor.md)
- [Security model](docs/security-model.md)
- [MVP roadmap](docs/roadmap.md)
- [MVP implementation plan](docs/superpowers/plans/2026-07-20-codem-mvp.md)
- [ADR 0001: Bun and TypeScript](docs/adr/0001-bun-typescript.md)
- [ADR 0002: Modular monolith](docs/adr/0002-modular-monolith.md)

## MVP boundary

This branch is a local feasibility release. It does not yet include Streamable HTTP, OAuth, persistent PTY sessions, container sandboxing, patch application, or Git mutation tools. Remote terminal execution must not be enabled until a sandbox executor and authentication layer are implemented.
