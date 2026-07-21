import { open, stat } from "node:fs/promises";
import type { ProcessExecutionResult, ProcessRunner } from "@codem/core";
import { CodeMError, resolveWorkspacePath } from "@codem/core";

const DEFAULT_FILE_LIMIT_BYTES = 256 * 1024;
const DEFAULT_OUTPUT_LIMIT_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

export interface ReadWorkspaceFileResult {
  path: string;
  content: string;
  sizeBytes: number;
  truncated: boolean;
}

export interface TerminalExecInput {
  command: string;
  args?: readonly string[];
  cwd?: string;
  timeoutMs?: number;
}

export async function readWorkspaceFile(
  workspaceRoot: string,
  requestedPath: string,
  maxBytes = DEFAULT_FILE_LIMIT_BYTES,
): Promise<ReadWorkspaceFileResult> {
  const resolvedPath = await resolveWorkspacePath(workspaceRoot, requestedPath);
  const fileStat = await stat(resolvedPath);

  if (!fileStat.isFile()) {
    throw new CodeMError("INVALID_INPUT", "The requested path is not a regular file.");
  }

  const limit = Math.max(1, Math.min(maxBytes, DEFAULT_FILE_LIMIT_BYTES));
  const buffer = new Uint8Array(limit + 1);
  const handle = await open(resolvedPath, "r");
  try {
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    const accepted = buffer.subarray(0, Math.min(bytesRead, limit));
    if (accepted.includes(0)) {
      throw new CodeMError("INVALID_INPUT", "Binary files are not supported by this MVP tool.");
    }

    return {
      path: requestedPath,
      content: new TextDecoder().decode(accepted),
      sizeBytes: fileStat.size,
      truncated: fileStat.size > limit,
    };
  } finally {
    await handle.close();
  }
}

export async function executeTerminal(
  processRunner: ProcessRunner,
  workspaceRoot: string,
  input: TerminalExecInput,
  signal: AbortSignal,
): Promise<ProcessExecutionResult> {
  const command = input.command.trim();
  if (!command) {
    throw new CodeMError("INVALID_INPUT", "Command must not be empty.");
  }

  const cwd = await resolveWorkspacePath(workspaceRoot, input.cwd ?? ".");
  const timeoutMs = Math.max(1, Math.min(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS));

  const environment: Record<string, string> = {};
  for (const name of ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL"]) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }

  return processRunner.execute(
    {
      command,
      args: input.args ?? [],
      cwd,
      env: environment,
      timeoutMs,
      stdoutLimitBytes: DEFAULT_OUTPUT_LIMIT_BYTES,
      stderrLimitBytes: DEFAULT_OUTPUT_LIMIT_BYTES,
    },
    {
      requestId: crypto.randomUUID(),
      workspaceRoot,
      signal,
    },
  );
}
