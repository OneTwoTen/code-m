export class OutboundHttpTimeoutError extends Error {
  constructor(message = "Outbound HTTP request timed out.") {
    super(message);
    this.name = "OutboundHttpTimeoutError";
  }
}

interface ComposedAbortSignal {
  signal: AbortSignal;
  didTimeout(): boolean;
  cleanup(): void;
}

function composeAbortSignal(callerSignal: AbortSignal | null | undefined, timeoutMs: number) {
  const controller = new AbortController();
  let timedOut = false;

  const onCallerAbort = () => {
    controller.abort(callerSignal?.reason);
  };

  if (callerSignal?.aborted) {
    onCallerAbort();
  } else {
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  }

  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new OutboundHttpTimeoutError());
  }, timeoutMs);

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      clearTimeout(timeout);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    },
  } satisfies ComposedAbortSignal;
}

export async function fetchWithTimeout(
  fetchFn: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = 10_000,
): Promise<Response> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("Outbound HTTP timeout must be a positive number.");
  }

  const composed = composeAbortSignal(init.signal, timeoutMs);
  try {
    return await fetchFn(input, { ...init, signal: composed.signal });
  } catch (error) {
    if (composed.didTimeout()) {
      throw new OutboundHttpTimeoutError();
    }
    throw error;
  } finally {
    composed.cleanup();
  }
}
