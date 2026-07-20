# CodeM Tool Catalog

## 1. Naming and design rules

Tool names use `<domain>.<action>` and remain stable after release.

Each tool:

- performs one operation
- has explicit input and output schemas
- declares read, write, execute, and network effects
- reports truncation and partial completion
- is idempotent when practical
- avoids returning large unstructured logs

Read, write, and execute tools are kept separate so clients and administrators can grant narrow permissions.

## 2. MVP tools

### `project.inspect`

Detects the project profile without changing the workspace.

Inputs:

```ts
{
  path?: string;
  depth?: number;
}
```

Outputs include languages, package managers, frameworks, build systems, test runners, lint commands, workspace packages, and important manifest paths.

Effects: read-only.

### `workspace.list_files`

Lists files and directories beneath a workspace-relative path.

Inputs:

```ts
{
  path?: string;
  depth?: number;
  includeHidden?: boolean;
  ignore?: string[];
  cursor?: string;
  limit?: number;
}
```

Outputs are paginated and always use workspace-relative normalized paths.

Effects: read-only.

### `workspace.read_file`

Reads a bounded text range.

Inputs:

```ts
{
  path: string;
  startLine?: number;
  endLine?: number;
  maxBytes?: number;
}
```

Outputs include encoding, selected line range, total lines when known, truncation status, and content.

Binary files are rejected or returned as artifact metadata, not decoded implicitly.

Effects: read-only.

### `workspace.search_text`

Searches text using a literal string or regular expression.

Inputs:

```ts
{
  query: string;
  path?: string;
  mode?: "literal" | "regex";
  caseSensitive?: boolean;
  include?: string[];
  exclude?: string[];
  maxResults?: number;
}
```

Outputs contain file, line, column, bounded preview, and match count metadata.

Effects: read-only.

### `workspace.apply_patch`

Applies a unified diff after validating workspace boundaries and file preconditions.

Inputs:

```ts
{
  patch: string;
  dryRun?: boolean;
}
```

Outputs contain affected paths, additions, deletions, rejected hunks, and whether any change was written.

The operation is atomic at the logical request level where supported. A dry run performs all validation without writing.

Effects: write. Approval may be required by host policy.

### `git.status`

Returns normalized repository status.

Inputs:

```ts
{
  path?: string;
  includeUntracked?: boolean;
}
```

Outputs distinguish staged, unstaged, untracked, conflicted, renamed, and deleted paths.

Effects: read-only.

### `git.diff`

Returns a bounded diff or stores the complete diff as an artifact.

Inputs:

```ts
{
  path?: string;
  staged?: boolean;
  base?: string;
  head?: string;
  maxBytes?: number;
}
```

Effects: read-only.

### `terminal.exec`

Runs one non-interactive process. See [Terminal executor](terminal-executor.md).

Inputs:

```ts
{
  command: string;
  args?: string[];
  cwd?: string;
  stdin?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}
```

Outputs:

```ts
{
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
```

Effects: execute; write and network effects depend on the command. Approval is normally required for unrestricted use.

### `quality.test`

Selects and runs the detected test command through `ProcessRunner`.

Inputs:

```ts
{
  path?: string;
  target?: string;
  watch?: false;
  timeoutMs?: number;
}
```

The MVP explicitly rejects watch mode. Output normalizes command, exit status, duration, and a bounded summary.

Effects: execute; may write caches or generated test output.

### `quality.lint`

Runs the detected lint command and normalizes diagnostics.

Inputs:

```ts
{
  path?: string;
  fix?: boolean;
  timeoutMs?: number;
}
```

`fix: false` is read/execute. `fix: true` is write/execute and requires the corresponding permission.

## 3. Phase-two tools

- `workspace.write_file`: replace or create one complete text file with precondition support
- `workspace.delete_path`: delete a file or empty directory with explicit approval
- `quality.format`: check or apply formatting
- `project.build`: execute the detected build pipeline
- `git.log`: return bounded normalized commit history
- `git.create_branch`: create a branch without checking it out globally when the adapter supports it
- `git.commit`: create a commit from an explicitly defined change set
- `diagnostics.collect`: aggregate compiler, test, and lint diagnostics
- `artifact.read`: page through large stored output

## 4. Later interactive terminal tools

Interactive terminal sessions are intentionally not part of the MVP.

Potential contract:

- `terminal.start`
- `terminal.write`
- `terminal.read`
- `terminal.resize`
- `terminal.stop`

These tools require PTY isolation, session ownership, idle expiration, output buffering, and stronger resource controls.

## 5. Tool annotations

Every tool declares:

```ts
interface ToolEffects {
  readOnly: boolean;
  writesWorkspace: boolean;
  executesProcess: boolean;
  mayUseNetwork: boolean;
  destructive: boolean;
  requiresApproval: boolean;
}
```

Host-specific annotations are derived from this generic metadata rather than embedded in core code.

## 6. Versioning

Breaking changes to a released input or output schema require one of:

- a new tool name
- a versioned tool name
- a negotiated server major version

Adding optional output fields is permitted. Removing fields or changing their meaning is breaking.