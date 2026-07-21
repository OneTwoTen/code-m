export interface ExecutionContext {
  requestId: string;
  workspaceRoot: string;
  signal: AbortSignal;
}

export interface ProcessExecutionRequest {
  command: string;
  args: readonly string[];
  cwd: string;
  stdin?: string;
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
  stdoutLimitBytes: number;
  stderrLimitBytes: number;
  stdinLimitBytes: number;
  terminationGraceMs: number;
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
}

export interface ProcessRunner {
  execute(
    request: ProcessExecutionRequest,
    context: ExecutionContext,
  ): Promise<ProcessExecutionResult>;
}
