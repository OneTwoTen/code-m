import { describe, expect, test } from "bun:test";
import { OutboundHttpTimeoutError, fetchWithTimeout } from "./fetch-with-timeout.ts";

function pendingFetch(): typeof fetch {
  return ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) {
        reject(new Error("expected an abort signal"));
        return;
      }
      const rejectFromSignal = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      if (signal.aborted) rejectFromSignal();
      else signal.addEventListener("abort", rejectFromSignal, { once: true });
    })) as typeof fetch;
}

describe("fetchWithTimeout", () => {
  test("aborts a request after its deadline", async () => {
    await expect(
      fetchWithTimeout(pendingFetch(), "https://example.com", {}, 5),
    ).rejects.toBeInstanceOf(OutboundHttpTimeoutError);
  });

  test("preserves a caller initiated abort", async () => {
    const controller = new AbortController();
    controller.abort(new Error("caller cancelled"));

    await expect(
      fetchWithTimeout(pendingFetch(), "https://example.com", { signal: controller.signal }, 100),
    ).rejects.toThrow("caller cancelled");
  });
});
