import type {
  ExecutionContext,
  ProcessExecutionRequest,
  ProcessExecutionResult,
  ProcessRunner,
} from "@codem/core";

interface CollectedStream {
  text: string;
  truncated: boolean;
}

async function collectStream(
  stream: ReadableStream<Uint8Array>,
  limitBytes: number,
): Promise<CollectedStream> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let collectedBytes = 0;
  let truncated = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    const remaining = Math.max(0, limitBytes - collectedBytes);
    if (remaining > 0) {
      const accepted = value.byteLength <= remaining ? value : value.subarray(0, remaining);
      chunks.push(accepted);
      collectedBytes += accepted.byteLength;
    }

    if (value.byteLength > remaining) truncated = true;
  }

  const merged = new Uint8Array(collectedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return {
    text: new TextDecoder().decode(merged),
    truncated,
  };
}

export class BunProcessRunner implements ProcessRunner {
  async execute(
    request: ProcessExecutionRequest,
    context: ExecutionContext,
  ): Promise<ProcessExecutionResult> {
    const startedAt = performance.now();
    let timedOut = false;
    let cancelled = false;

    const child = Bun.spawn({
      cmd: [request.command, ...request.args],
      cwd: request.cwd,
      env: { ...request.env },
      stdin: request.stdin === undefined ? "ignore" : new Blob([request.stdin]),
      stdout: "pipe",
      stderr: "pipe",
    });

    const kill = () => {
      try {
        child.kill();
      } catch {
        // Process may already have exited.
      }
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      kill();
    }, request.timeoutMs);

    const onAbort = () => {
      cancelled = true;
      kill();
    };

    context.signal.addEventListener("abort", onAbort, { once: true });

    const [stdout, stderr, exitCode] = await Promise.all([
      collectStream(child.stdout, request.stdoutLimitBytes),
      collectStream(child.stderr, request.stderrLimitBytes),
      child.exited,
    ]);

    clearTimeout(timeout);
    context.signal.removeEventListener("abort", onAbort);

    return {
      exitCode,
      signal: null,
      stdout: stdout.text,
      stderr: stderr.text,
      durationMs: performance.now() - startedAt,
      timedOut,
      cancelled,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
    };
  }
}
