# Security Model

## Trust boundaries

CodeM treats MCP clients, model-generated arguments, repository content, command output, and downloaded dependencies as untrusted.

The MCP server, policy engine, credential broker, and sandbox controller are trusted components. A local workspace may be trusted for development convenience, but remote execution must assume malicious repository content.

## Permission model

Capabilities are granted independently:

- read workspace
- write workspace
- execute process
- use network
- access credentials
- perform destructive operations

A tool call is allowed only when both the caller and the selected tool possess the required capabilities.

## Required controls

- Canonical workspace-boundary validation, including symlink handling.
- Schema validation for every tool input and output.
- `shell: false` semantics for the MVP terminal executor.
- Explicit environment allowlist.
- Timeout, process, memory, output, and concurrency limits.
- Network disabled by default in remote sandboxes.
- Secret redaction for returned output, artifacts, and audit previews.
- Approval requirement for broad terminal execution and destructive writes.
- Per-session ownership for jobs, artifacts, and future terminal sessions.
- Authentication, origin checks, host checks, and rate limits for HTTP transport.

## Threats addressed

### Path traversal and symlink escape

All workspace paths are normalized and resolved against an authorized root. Existing symlinks are resolved before access. Operations that create paths validate the nearest existing parent and recheck before mutation.

### Command injection

The public terminal contract separates executable and arguments. Shell command strings are not accepted. Specialized quality and Git tools build commands from validated templates.

### Resource exhaustion

Execution is bounded by wall-clock timeout, output byte limits, process concurrency, and sandbox CPU/memory/process quotas.

### Secret leakage

Server environment is not forwarded wholesale. Credentials use explicit scoped injection. Output and metadata pass through redaction before leaving the trusted boundary.

### Cross-session access

Workspace roots, job IDs, artifacts, and terminal sessions are associated with an authenticated actor/session. Possessing an identifier alone does not grant access.

### Repository-triggered attacks

Remote execution occurs in a non-root sandbox with a controlled filesystem, restricted capabilities, and network disabled unless granted. Dependency lifecycle scripts are treated as executable code.

## Local versus remote mode

Local stdio mode may run processes directly for developer convenience, while still enforcing path, timeout, environment, and output policies.

Remote HTTP mode must use sandboxed execution. CodeM must refuse remote `terminal.exec` when no sandbox executor is configured.

## Audit requirements

Audit events record request identity, tool, policy decision, affected workspace-relative paths, command metadata after redaction, timings, result status, and artifact identifiers. Raw source content, stdin, secrets, and full terminal output are excluded by default.

## Security testing

The test suite must cover:

- `../` traversal
- absolute path injection
- symlink escape
- command argument metacharacters remaining literal
- environment secret rejection
- timeout and cancellation
- output truncation without deadlock
- unauthorized write and execute calls
- cross-session artifact access
- remote execution without sandbox configuration
