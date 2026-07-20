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
- Docker image for isolated local execution

## Available MVP tools

| Tool | Purpose | Effect |
|---|---|---|
| `system.info` | Report CodeM version, runtime, workspace, and capabilities | Read-only |
| `workspace.read_file` | Read a bounded UTF-8 file inside the workspace | Read-only |
| `terminal.exec` | Run one executable with a separate argument array | Execute; may change files |

`terminal.exec` does not accept an opaque shell string. It enforces a workspace-relative working directory, timeout, output limits, and a reduced environment.

## Requirements

- Bun 1.3.3 for local development
- Docker for container execution

## Install

```bash
bun install --frozen-lockfile
```

## Environment configuration

Copy the example file for local development:

```bash
cp .env.example .env
```

The MVP currently reads one environment variable:

| Variable | Default | Purpose |
|---|---|---|
| `CODEM_WORKSPACE_ROOT` | Current process directory | Absolute or relative path CodeM is allowed to access |

For a coding project outside this repository, set an absolute path:

```env
CODEM_WORKSPACE_ROOT=/absolute/path/to/project
```

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

## Run locally

```bash
CODEM_WORKSPACE_ROOT=/absolute/path/to/project bun run dev
```

Bun also loads `.env` automatically when the server starts from the repository root.

The server communicates on stdout using MCP JSON-RPC. Diagnostics are written only to stderr.

## Run with Docker

Build the image:

```bash
docker build -t codem-mcp .
```

Run the stdio server and mount the authorized project at `/workspace`:

```bash
docker run --rm -i \
  -e CODEM_WORKSPACE_ROOT=/workspace \
  -v /absolute/path/to/project:/workspace \
  codem-mcp
```

The image runs as the unprivileged `bun` user. No network port is exposed because the MVP uses stdio. Commands invoked through `terminal.exec` run inside the container, not on the Docker host.

Use a read-only volume while testing read-only tools:

```bash
docker run --rm -i \
  -e CODEM_WORKSPACE_ROOT=/workspace \
  -v /absolute/path/to/project:/workspace:ro \
  codem-mcp
```

## Example MCP client configuration

### Local Bun process

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

### Docker process

```json
{
  "mcpServers": {
    "code-m": {
      "command": "docker",
      "args": [
        "run",
        "--rm",
        "-i",
        "-e",
        "CODEM_WORKSPACE_ROOT=/workspace",
        "-v",
        "/absolute/path/to/project:/workspace",
        "codem-mcp"
      ]
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
├── Dockerfile
├── .dockerignore
├── .env.example
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

This branch is a local feasibility release. It does not yet include Streamable HTTP, OAuth, persistent PTY sessions, patch application, or Git mutation tools. The Docker image reduces host exposure but is not yet a hardened multi-tenant sandbox. Remote terminal execution must not be enabled until authentication, authorization, resource limits, and a dedicated sandbox executor are implemented.
