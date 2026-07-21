# Terminal Executor

## 1. Scope

The MVP terminal capability executes one non-interactive process and waits for completion. It is not a persistent shell and does not emulate a terminal session.

Public MCP tool: `terminal.exec`.

Internal abstraction: `ProcessRunner`.

Default local adapter: `BunProcessRunner` implemented with `Bun.spawn`.

Remote and untrusted deployments should use a container-backed `ProcessRunner` implementation.

## 2. Why not accept a shell string

CodeM accepts an executable plus an argument array:

```ts
{
  command: "bun",
  args: ["test"],
  cwd: "packages/core"
}
```

It does not accept an opaque shell program such as:

```text
cd packages/core && bun test | tee result.log
```

The adapter runs with shell parsing disabled. This avoids accidental command composition, quoting ambiguity, and direct shell metacharacter injection.

A future explicit shell tool would be a separate high-risk capability with separate permissions.

## 3. Core contracts

```ts
export interface ProcessExecutionRequest {
  command: string;
  args: readonly string[];
  cwd: string;
  stdin?: string;
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
  stdoutLimitBytes: number;
  stderrLimitBytes: number;
}

export interface ProcessExecutionResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  artifactId?: string;
}

export interface ProcessRunner {
  execute(
    request: ProcessExecutionRequest,
    context: ExecutionContext,
  ): Promise<ProcessExecutionResult>;
}
```

## 4. Bun adapter behavior

The adapter builds `cmd` as an array and calls `Bun.spawn`.

Required behavior:

1. Resolve and validate `cwd` before spawning.
2. Build an environment from an allowlisted base plus approved overrides.
3. Use pipe or ignore for standard streams; never inherit server stdin/stdout in remote mode.
4. Stream stdout and stderr into independent bounded collectors.
5. Persist the complete stream to an artifact when configured and size limits are exceeded.
6. Abort on request cancellation.
7. Kill the process on timeout.
8. Attempt to terminate descendants, not only the immediate child.
9. Await process exit and stream completion.
10. Redact secrets before returning output.

Illustrative adapter boundary:

```ts
const child = Bun.spawn({
  cmd: [request.command, ...request.args],
  cwd: request.cwd,
  env: request.env,
  stdin: request.stdin === undefined ? "ignore" : "pipe",
  stdout: "pipe",
  stderr: "pipe",
});
```

This code belongs only in the Bun adapter.

## 5. Workspace boundary

`cwd` is supplied as a workspace-relative path by the public tool.

Validation procedure:

1. Reject empty bytes, invalid encoding, and platform-invalid paths.
2. Join the relative path to the authorized workspace root.
3. Resolve existing parent components and symbolic links.
4. Compare canonical paths using platform-aware rules.
5. Reject paths outside the workspace.
6. Recheck relevant paths immediately before execution when the threat model includes concurrent mutation.

The model must never provide or replace the authorized workspace root.

## 6. Command policy

Policy evaluates the resolved command before execution.

Possible decisions:

```ts
type PolicyDecision =
  | { kind: "allow" }
  | { kind: "deny"; reason: string }
  | { kind: "approval-required"; reason: string; risk: string };
```

Policy inputs include:

- actor and session
- requested executable and arguments
- workspace
- requested environment
- network permission
- write permission
- local versus remote deployment
- specialized tool that initiated execution

Specialized tools may use command templates. For example, `quality.test` can invoke a detected test command without granting the caller unrestricted `terminal.exec` permission.

## 7. Environment policy

The executor starts from a small explicit environment rather than blindly forwarding the server environment.

Typical safe variables:

- `PATH` from server configuration
- `HOME` mapped to an isolated directory
- temporary directory variables
- locale variables
- approved package cache locations
- CI-style non-interactive flags

Variables matching secret patterns are not accepted from tool input. Host-provided credentials require a dedicated credential broker and scoped injection mechanism.

## 8. Limits

Recommended initial defaults:

| Limit | Local stdio | Remote HTTP |
|---|---:|---:|
| Timeout | 60 seconds | 30 seconds |
| Max requested timeout | 10 minutes | 2 minutes |
| stdout inline | 1 MiB | 256 KiB |
| stderr inline | 1 MiB | 256 KiB |
| stdin | 256 KiB | 64 KiB |
| concurrent processes per session | 4 | 2 |

These defaults are configuration, not tool-controlled policy. A caller may request a lower value. A higher value is capped or requires approval.

## 9. Cancellation and process trees

Cancellation sources:

- MCP request cancellation
- client disconnect
- policy revocation
- timeout
- server shutdown

The executor records why termination occurred. On Unix-like systems, sandboxed execution should use a process group or container boundary so descendants can be terminated reliably. On Windows, use an appropriate job-object or container mechanism.

A successful signal to the immediate child is not sufficient evidence that all descendants stopped.

## 10. Output handling

stdout and stderr remain separate. Collectors decode UTF-8 with replacement for malformed sequences and track byte counts before decoding.

When output exceeds a limit:

- continue draining the process stream to avoid deadlock
- stop accumulating inline text
- set the relevant truncation flag
- optionally persist complete output as an artifact
- include the artifact identifier in the result

Secret redaction is applied to inline output, stored logs, and audit previews.

## 11. Audit event

Each execution emits an audit event containing:

- request, session, and actor identifiers
- workspace identifier, not secret filesystem details where avoidable
- command and arguments after safe redaction
- policy decision
- start and finish times
- exit code or signal
- timeout and cancellation status
- byte counts and truncation flags
- artifact identifiers

Audit records must not contain raw stdin or full command output by default.

## 12. Container executor

The remote executor should run commands in a disposable or resettable container with:

- workspace mounted at a controlled path
- read-only root filesystem when possible
- non-root user
- CPU, memory, process, and disk limits
- network disabled by default
- seccomp/AppArmor or equivalent isolation
- restricted capabilities
- isolated temporary and home directories
- explicit artifact extraction

The MCP server process must not run untrusted commands directly on its own host.

## 13. Interactive terminal phase

Interactive PTY support is deferred. It requires:

- PTY adapter, likely `node-pty` or a remote sandbox PTY API
- session ownership and authorization on every operation
- bounded replay buffer and cursor semantics
- idle and absolute expiration
- resize handling
- backpressure
- reconnect rules
- cleanup after client loss

Persistent terminal sessions must always be sandboxed in remote deployments.