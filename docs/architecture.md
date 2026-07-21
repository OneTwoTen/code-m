# CodeM Architecture

## 1. Purpose

CodeM provides coding agents with a controlled interface to a source workspace. It is responsible for project inspection, file operations, Git operations, process execution, diagnostics, and quality checks.

CodeM is not an autonomous coding agent. It does not decide what changes to make. It exposes capabilities that an agent can invoke through MCP.

## 2. Architectural style

The initial system is a modular monolith with ports and adapters.

```text
MCP client
    |
    v
MCP transport and tool registration
    |
    v
Tool handlers
    |
    v
Core use cases and policies
    |
    v
Ports
    |
    v
Filesystem, Git, process, sandbox, persistence adapters
```

The modular monolith keeps deployment simple while preserving boundaries that allow process execution or persistence to be extracted later.

## 3. Repository structure

```text
apps/
  mcp-server/
    src/
      main.ts
      server/
      transports/
      middleware/
      routes/
  web/                         # optional

packages/
  tool-contracts/
  tools/
  core/
  policy/
  adapters/
  host-openai/
  observability/
  testkit/

tests/
  contract/
  integration/
  e2e/
  security/
```

### `apps/mcp-server`

Composition root and protocol boundary. It creates the MCP server, selects transports, constructs dependencies, registers tools and resources, and maps domain errors to protocol responses.

It must not contain filesystem, Git, or process business logic.

### `packages/tool-contracts`

Shared public contracts:

- tool definition
- Zod input and output schemas
- execution context
- normalized errors
- pagination and truncation metadata
- approval requirements

Contracts must not import server, transport, ChatGPT, or Bun-specific modules.

### `packages/tools`

One directory per public MCP tool. Each tool owns its schema, metadata, handler, and tests.

```text
tools/src/workspace/read-file/
  schema.ts
  metadata.ts
  handler.ts
  handler.test.ts
  index.ts
```

Handlers validate intent-level input and call core use cases. They do not directly access `Bun.spawn`, `node:fs`, or Git commands.

### `packages/core`

Contains application and domain behavior:

- workspace inspection
- project profile detection
- patch planning and application
- process execution orchestration
- Git use cases
- diagnostics normalization
- artifact management

Core depends on ports, not concrete adapters.

### `packages/policy`

Central authorization and safety rules:

- workspace boundary
- path access
- command execution
- environment variables
- output limits
- timeout limits
- network permissions
- approval requirements
- secret redaction

Policy decisions return structured allow, deny, or approval-required results.

### `packages/adapters`

Concrete integrations:

- Node-compatible filesystem
- Bun process execution
- Git CLI
- ripgrep or fallback text search
- local artifact storage
- container sandbox

Bun-specific APIs are restricted to adapters and application entrypoints.

### `packages/host-openai`

Optional ChatGPT Apps SDK compatibility layer. It maps generic tool definitions and results to OpenAI-specific metadata, resources, and widget configuration.

Core tools remain usable by other MCP clients when this package is absent.

## 4. Runtime and workspace model

Each tool call receives an immutable execution context:

```ts
export interface ExecutionContext {
  requestId: string;
  sessionId?: string;
  actorId?: string;
  workspaceRoot: string;
  permissions: {
    read: boolean;
    write: boolean;
    execute: boolean;
    network: boolean;
  };
  limits: {
    timeoutMs: number;
    stdoutBytes: number;
    stderrBytes: number;
    resultBytes: number;
  };
  signal: AbortSignal;
}
```

`workspaceRoot` is never global. A request cannot select an arbitrary absolute root unless the host has already authorized it.

## 5. Tool execution flow

1. Transport authenticates the caller when required.
2. Server creates `ExecutionContext`.
3. MCP SDK validates the request envelope.
4. Tool schema validates arguments.
5. Tool handler creates a use-case request.
6. Policy evaluates access and approval requirements.
7. Core invokes ports.
8. Adapter performs the operation.
9. Output is normalized, truncated, and redacted.
10. Server returns structured content and an optional artifact reference.
11. Audit metadata is recorded.

## 6. Error model

Errors are stable and machine-readable:

```ts
export type CodeMErrorCode =
  | "INVALID_INPUT"
  | "PERMISSION_DENIED"
  | "APPROVAL_REQUIRED"
  | "PATH_OUTSIDE_WORKSPACE"
  | "NOT_FOUND"
  | "CONFLICT"
  | "PROCESS_TIMEOUT"
  | "PROCESS_FAILED"
  | "OUTPUT_LIMIT_EXCEEDED"
  | "UNSUPPORTED_PROJECT"
  | "INTERNAL_ERROR";
```

Every error includes a safe user-facing message and may include structured details. Raw stack traces and secrets are never returned to the model.

## 7. State model

Server-side state:

- authorized workspace roots
- job and process records
- terminal session state
- artifact metadata
- audit events
- approval decisions

Widget-only state:

- selected tab
- expanded file
- scroll position
- local filters

Coding state must not exist only inside a ChatGPT widget.

## 8. Transport strategy

### `stdio`

Default for local coding agents. It has low setup cost and inherits the local agent's process boundary.

### Streamable HTTP

Used for remote clients and ChatGPT. It requires authentication, origin and host checks, rate limits, request size limits, and sandboxed execution.

The two transports share the same tool registry and application services.

## 9. Output strategy

Tool results use predictable structured data. Inline output is bounded. Large files, logs, patches, and reports are written as artifacts and returned by reference.

Every bounded output reports:

- whether truncation occurred
- original or estimated size when available
- artifact identifier when the complete output was persisted

## 10. Dependency direction

Allowed:

```text
apps -> tools -> core -> ports
apps -> adapters -> ports
host-openai -> tool-contracts
policy -> tool-contracts
```

Forbidden:

```text
core -> MCP SDK
core -> ChatGPT Apps SDK
core -> Bun APIs
core -> concrete filesystem/process adapters
tool handlers -> Bun.spawn
```

## 11. Future extraction points

The following may become separate services only when required:

- sandbox executor
- artifact storage
- job queue
- indexing and semantic search
- organization policy service

Their current interfaces must be designed as ports so extraction does not change public tool contracts.