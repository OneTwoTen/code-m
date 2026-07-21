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

type TerminationSignal = "SIGTERM" | "SIGKILL";

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

function stdinSize(value: string | undefined): number {
  return value === undefined ? 0 : new TextEncoder().encode(value).byteLength;
}

export class BunProcessRunner implements ProcessRunner {
  async execute(
    request: ProcessExecutionRequest,
    context: ExecutionContext,
  ): Promise<ProcessExecutionResult> {
    if (stdinSize(request.stdin) > request.stdinLimitBytes) {
      throw new Error("Process stdin exceeds the configured byte limit.");
    }

    const startedAt = performance.now();
    let timedOut = false;
    let cancelled = false;
    let terminationStarted = false;
    let escalation: ReturnType<typeof setTimeout> | undefined;

    const child = Bun.spawn({
      cmd: [request.command, ...request.args],
      cwd: request.cwd,
      env: { ...request.env },
      stdin: request.stdin === undefined ? "ignore" : new Blob([request.stdin]),
      stdout: "pipe",
      stderr: "pipe",
      detached: process.platform !== "win32",
    });

    const signalProcessTree = (signal: TerminationSignal) => {
      if (process.platform !== "win32") {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // The process group may already be gone or unavailable.
        }
      }

      try {
        child.kill(signal);
      } catch {
        // Process may already have exited.
      }
    };

    const terminate = () => {
      if (terminationStarted) return;
      terminationStarted = true;
      signalProcessTree("SIGTERM");
      escalation = setTimeout(() => {
        signalProcessTree("SIGKILL");
      }, request.terminationGraceMs);
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, request.timeoutMs);

    const onAbort = () => {
      cancelled = true;
      terminate();
    };

    context.signal.addEventListener("abort", onAbort, { once: true });
    if (context.signal.aborted) onAbort();

    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        collectStream(child.stdout, request.stdoutLimitBytes),
        collectStream(child.stderr, request.stderrLimitBytes),
        child.exited,
      ]);

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
    } finally {
      clearTimeout(timeout);
      if (escalation) clearTimeout(escalation);
      context.signal.removeEventListener("abort", onAbort);
    }
  }
}
