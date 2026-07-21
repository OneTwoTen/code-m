import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function request(overrides: Partial<ProcessExecutionRequest> = {}): ProcessExecutionRequest {
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

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
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

  test("stops descendants after the direct child exits during termination grace", async () => {
    if (process.platform === "win32") return;

    const temporaryDirectory = await mkdtemp(join(tmpdir(), "codem-process-tree-"));
    const heartbeatPath = join(temporaryDirectory, "heartbeat");
    const descendantScript = `
      process.on("SIGTERM", () => {});
      let count = 0;
      while (true) {
        await Bun.write(${JSON.stringify(heartbeatPath)}, String(++count));
        await Bun.sleep(10);
      }
    `;
    const parentScript = `
      const child = Bun.spawn({
        cmd: [process.execPath, "-e", ${JSON.stringify(descendantScript)}],
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      while (!(await Bun.file(${JSON.stringify(heartbeatPath)}).exists())) {
        await Bun.sleep(5);
      }
      console.log(child.pid);
      await Bun.sleep(10000);
    `;

    let descendantPid = 0;
    try {
      const result = await runner.execute(
        request({
          args: ["-e", parentScript],
          timeoutMs: 500,
          terminationGraceMs: 50,
        }),
        context(),
      );

      descendantPid = Number(result.stdout.trim());
      expect(result.timedOut).toBe(true);
      expect(Number.isInteger(descendantPid)).toBe(true);

      const heartbeatAfterReturn = await Bun.file(heartbeatPath).text();
      await Bun.sleep(100);
      expect(await Bun.file(heartbeatPath).text()).toBe(heartbeatAfterReturn);
    } finally {
      if (descendantPid && processExists(descendantPid)) {
        process.kill(descendantPid, "SIGKILL");
      }
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
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

  test("does not spawn when the request is already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await runner.execute(
      request({ command: "codem-command-that-does-not-exist" }),
      context(controller.signal),
    );

    expect(result).toMatchObject({
      exitCode: null,
      timedOut: false,
      cancelled: true,
      stdout: "",
      stderr: "",
    });
  });

  test("rejects stdin larger than the configured byte limit", async () => {
    await expect(
      runner.execute(request({ stdin: "x".repeat(33), stdinLimitBytes: 32 }), context()),
    ).rejects.toThrow("stdin exceeds the configured byte limit");
  });
});
