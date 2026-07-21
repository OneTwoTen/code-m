import { describe, expect, test } from "bun:test";
import { BunProcessRunner } from "./bun-process-runner.ts";

const runner = new BunProcessRunner();

function context() {
  return {
    requestId: crypto.randomUUID(),
    workspaceRoot: process.cwd(),
    signal: new AbortController().signal,
  };
}

describe("BunProcessRunner", () => {
  test("captures stdout from a successful process", async () => {
    const result = await runner.execute(
      {
        command: process.execPath,
        args: ["-e", "console.log('codem-ok')"],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? "" },
        timeoutMs: 5_000,
        stdoutLimitBytes: 1_024,
        stderrLimitBytes: 1_024,
      },
      context(),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("codem-ok");
    expect(result.stdoutTruncated).toBe(false);
  });

  test("truncates output after the byte limit", async () => {
    const result = await runner.execute(
      {
        command: process.execPath,
        args: ["-e", "console.log('x'.repeat(200))"],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? "" },
        timeoutMs: 5_000,
        stdoutLimitBytes: 32,
        stderrLimitBytes: 32,
      },
      context(),
    );

    expect(result.stdoutTruncated).toBe(true);
    expect(new TextEncoder().encode(result.stdout).byteLength).toBeLessThanOrEqual(32);
  });

  test("kills a process after timeout", async () => {
    const result = await runner.execute(
      {
        command: process.execPath,
        args: ["-e", "await Bun.sleep(1000)"],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? "" },
        timeoutMs: 25,
        stdoutLimitBytes: 32,
        stderrLimitBytes: 32,
      },
      context(),
    );

    expect(result.timedOut).toBe(true);
  });
});
