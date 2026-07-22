import { afterEach, describe, expect, test } from "bun:test";
import { access, rm } from "node:fs/promises";
import type {
  ExecutionContext,
  ProcessExecutionRequest,
  ProcessExecutionResult,
  ProcessRunner,
} from "@codem/core";
import { ProcessGitTransport } from "./process-git-transport.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function result(overrides: Partial<ProcessExecutionResult> = {}): ProcessExecutionResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    durationMs: 1,
    timedOut: false,
    cancelled: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    ...overrides,
  };
}

class RecordingRunner implements ProcessRunner {
  readonly requests: ProcessExecutionRequest[] = [];
  readonly contexts: ExecutionContext[] = [];
  readonly #results: ProcessExecutionResult[];

  constructor(results: ProcessExecutionResult[]) {
    this.#results = [...results];
  }

  async execute(
    request: ProcessExecutionRequest,
    context: ExecutionContext,
  ): Promise<ProcessExecutionResult> {
    this.requests.push(request);
    this.contexts.push(context);
    return this.#results.shift() ?? result();
  }
}

describe("ProcessGitTransport", () => {
  test("passes installation credentials only through an ephemeral askpass environment", async () => {
    const runner = new RecordingRunner([result()]);
    const transport = new ProcessGitTransport(runner);
    const checkoutPath = "/data/workspaces/ws_safe/repository";
    const token = "installation-secret-token";

    await transport.clone({
      cloneUrl: "https://github.example/owner/private.git",
      checkoutPath,
      credential: { username: "x-access-token", password: token },
      signal: new AbortController().signal,
    });

    const request = runner.requests[0];
    expect(request?.command).toBe("git");
    expect(request?.args).toEqual([
      "clone",
      "--no-checkout",
      "--origin",
      "origin",
      "https://github.example/owner/private.git",
      checkoutPath,
    ]);
    expect(JSON.stringify(request?.args)).not.toContain(token);
    expect(request?.env.CODEM_GIT_PASSWORD).toBe(token);
    expect(request?.env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(request?.env.GIT_ASKPASS).toBeString();
    expect(runner.contexts[0]?.signal.aborted).toBe(false);

    const askpass = request?.env.GIT_ASKPASS;
    if (!askpass) throw new Error("expected askpass path");
    await expect(access(askpass)).rejects.toBeDefined();
  });

  test("redacts credentials and remote stderr from fetch failures", async () => {
    const token = "do-not-leak-token";
    const failure = result({
      exitCode: 128,
      stderr: `fatal: https://x-access-token:${token}@github.example/owner/private.git denied`,
    });
    const runner = new RecordingRunner([failure, failure]);
    const transport = new ProcessGitTransport(runner);

    await expect(
      transport.fetch({
        checkoutPath: "/data/workspaces/ws_safe/repository",
        credential: { username: "x-access-token", password: token },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      operation: "fetch",
      message: "Git fetch failed.",
    });

    await transport
      .fetch({
        checkoutPath: "/data/workspaces/ws_safe/repository",
        credential: { username: "x-access-token", password: token },
        signal: new AbortController().signal,
      })
      .catch((error: unknown) => {
        expect(String(error)).not.toContain(token);
        expect(String(error)).not.toContain("x-access-token");
        expect(String(error)).not.toContain("github.example");
      });
  });

  test("detects dirty workspaces without a credential helper", async () => {
    const runner = new RecordingRunner([result({ stdout: " M README.md\n?? notes.txt\n" })]);
    const transport = new ProcessGitTransport(runner);

    expect(
      await transport.isDirty("/data/workspaces/ws_dirty/repository", new AbortController().signal),
    ).toBe(true);
    expect(runner.requests[0]?.env.CODEM_GIT_PASSWORD).toBeUndefined();
  });

  test("resolves a remote branch to a commit before detached checkout", async () => {
    const runner = new RecordingRunner([
      result({ exitCode: 1 }),
      result({ stdout: "abc123def456\n" }),
      result(),
    ]);
    const transport = new ProcessGitTransport(runner);

    const commit = await transport.checkoutRef(
      "/data/workspaces/ws_ref/repository",
      "release/v1",
      new AbortController().signal,
    );

    expect(commit).toBe("abc123def456");
    expect(runner.requests.map((request) => request.args)).toEqual([
      [
        "-C",
        "/data/workspaces/ws_ref/repository",
        "rev-parse",
        "--verify",
        "refs/remotes/origin/release/v1^{commit}",
      ],
      [
        "-C",
        "/data/workspaces/ws_ref/repository",
        "rev-parse",
        "--verify",
        "refs/tags/release/v1^{commit}",
      ],
      ["-C", "/data/workspaces/ws_ref/repository", "checkout", "--detach", "abc123def456"],
    ]);
  });
});
