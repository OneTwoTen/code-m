import { describe, expect, test } from "bun:test";
import type { ProcessExecutionRequest } from "@codem/core";
import { BunProcessRunner } from "./bun-process-runner.ts";

const runner = new BunProcessRunner();

function context(signal = new AbortController().signal) {
  return {
    requestId: crypto.randomUUID(),
    workspaceRoot: process.cwd(),
    signal,
  };
}

function request(
  overrides: Partial<ProcessExecutionRequest> = {},
): ProcessExecutionRequest {
  return {
    command: process.execPath,
    args: ["-e", "console.log('codem-ok')"],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? "" },
    timeoutMs: 5_000,
    stdoutLimitBytes: 1_024,
    stderrLimitBytes: 1_024,
    stdinLimitBytes: 64 * 1_024,
    terminationGraceMs: 100,
    ...overrides,
  };
}

describe("BunProcessRunner", () => {
  test("captures stdout from a successful process", async () => {
    const result = await runner.execute(request(), context());

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("codem-ok");
    expect(result.stdoutTruncated).toBe(false);
  });

  test("truncates output after the byte limit", async () => {
    const result = await runner.execute(
      request({
        args: ["-e", "console.log('x'.repeat(200))"],
        stdoutLimitBytes: 32,
        stderrLimitBytes: 32,
      }),
      context(),
    );

    expect(result.stdoutTruncated).toBe(true);
    expect(new TextEncoder().encode(result.stdout).byteLength).toBeLessThanOrEqual(32);
  });

  test("escalates termination when a timed-out process ignores SIGTERM", async () => {
    const result = await runner.execute(
      request({
        args: ["-e", "process.on('SIGTERM', () => {}); await Bun.sleep(10000)"],
        timeoutMs: 25,
        terminationGraceMs: 25,
      }),
      context(),
    );

    expect(result.timedOut).toBe(true);
    expect(result.durationMs).toBeLessThan(1_000);
  });

  test("terminates a process when the request is cancelled", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 25);

    const result = await runner.execute(
      request({ args: ["-e", "await Bun.sleep(10000)"] }),
      context(controller.signal),
    );

    expect(result.cancelled).toBe(true);
    expect(result.durationMs).toBeLessThan(1_000);
  });

  test("rejects stdin larger than the configured byte limit", async () => {
    await expect(
      runner.execute(
        request({ stdin: "x".repeat(33), stdinLimitBytes: 32 }),
        context(),
      ),
    ).rejects.toThrow("stdin exceeds the configured byte limit");
  });
});
