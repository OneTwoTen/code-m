import { afterEach, describe, expect, test } from "bun:test";
import { access, rm } from "node:fs/promises";
import { devNull } from "node:os";
import type {
  ExecutionContext,
  ProcessExecutionRequest,
  ProcessExecutionResult,
  ProcessRunner,
} from "@codem/core";
import { ProcessGitTransport } from "./process-git-transport.ts";

const temporaryDirectories: string[] = [];

const cloneUrl = "https://github.example/owner/private.git";
const checkoutPath = "/data/workspaces/ws_safe/repository";

function hardenedArgs(args: string[]): string[] {
  return [
    "-c",
    "credential.helper=",
    "-c",
    `core.hooksPath=${devNull}`,
    "-c",
    "protocol.allow=never",
    "-c",
    "protocol.https.allow=always",
    "-c",
    "http.followRedirects=initial",
    ...args,
  ];
}

function hookSafeArgs(args: string[]): string[] {
  return ["-c", `core.hooksPath=${devNull}`, ...args];
}

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
  test(
    "passes installation credentials only through an isolated ephemeral askpass environment",
    async () => {
      const runner = new RecordingRunner([result()]);
      const transport = new ProcessGitTransport(runner);
      const token = "installation-secret-token";

      await transport.clone({
        cloneUrl,
        checkoutPath,
        credential: { username: "x-access-token", password: token },
        signal: new AbortController().signal,
      });

      const request = runner.requests[0];
      expect(request?.command).toBe("git");
      expect(request?.args).toEqual(
        hardenedArgs([
          "clone",
          "--no-checkout",
          "--origin",
          "origin",
          cloneUrl,
          checkoutPath,
        ]),
      );
      expect(JSON.stringify(request?.args)).not.toContain(token);
      expect(request?.env.CODEM_GIT_PASSWORD).toBe(token);
      expect(request?.env.GIT_TERMINAL_PROMPT).toBe("0");
      expect(request?.env.GIT_CONFIG_NOSYSTEM).toBe("1");
      expect(request?.env.GIT_CONFIG_GLOBAL).toBe(devNull);
      expect(request?.env.GIT_ASKPASS).toBeString();
      expect(runner.contexts[0]?.signal.aborted).toBe(false);

      const askpass = request?.env.GIT_ASKPASS;
      if (!askpass) throw new Error("expected askpass path");
      await expect(access(askpass)).rejects.toBeDefined();
    },
  );

  test("redacts credentials and remote stderr from fetch failures", async () => {
    const token = "do-not-leak-token";
    const failure = result({
      exitCode: 128,
      stderr: `fatal: https://x-access-token:${token}@github.example/owner/private.git denied`,
    });
    const noRewrite = result({ exitCode: 1 });
    const runner = new RecordingRunner([
      noRewrite,
      result(),
      failure,
      noRewrite,
      result(),
      failure,
    ]);
    const transport = new ProcessGitTransport(runner);

    await expect(
      transport.fetch({
        cloneUrl,
        checkoutPath,
        credential: { username: "x-access-token", password: token },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      operation: "fetch",
      message: "Git fetch failed.",
    });

    await transport
      .fetch({
        cloneUrl,
        checkoutPath,
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
      await transport.isDirty(checkoutPath, new AbortController().signal),
    ).toBe(true);
    expect(runner.requests[0]?.args).toEqual(
      hookSafeArgs([
        "-C",
        checkoutPath,
        "status",
        "--porcelain=v1",
        "--untracked-files=normal",
      ]),
    );
    expect(runner.requests[0]?.env.CODEM_GIT_PASSWORD).toBeUndefined();
    expect(runner.requests[0]?.env.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(runner.requests[0]?.env.GIT_CONFIG_GLOBAL).toBe(devNull);
  });

  test(
    "fetches from freshly verified metadata instead of a mutable persisted origin",
    async () => {
      const runner = new RecordingRunner([result({ exitCode: 1 }), result(), result()]);
      const transport = new ProcessGitTransport(runner);

      await transport.fetch({
        cloneUrl,
        checkoutPath,
        credential: { username: "x-access-token", password: "installation-secret" },
        signal: new AbortController().signal,
      });

      expect(runner.requests.map((request) => request.args)).toEqual([
        hookSafeArgs([
          "-C",
          checkoutPath,
          "config",
          "--local",
          "--includes",
          "--get-regexp",
          "^url\\..*\\.insteadof$",
        ]),
        hookSafeArgs([
          "-C",
          checkoutPath,
          "config",
          "--local",
          "--replace-all",
          "remote.origin.url",
          cloneUrl,
        ]),
        hardenedArgs([
          "-C",
          checkoutPath,
          "fetch",
          "--prune",
          "--tags",
          cloneUrl,
          "+refs/heads/*:refs/remotes/origin/*",
        ]),
      ]);
      expect(runner.requests[2]?.args).not.toContain("origin");
      expect(runner.requests[2]?.env.CODEM_GIT_PASSWORD).toBe("installation-secret");
    },
  );

  test(
    "rejects repository-local URL rewrites before exposing credentials to Git",
    async () => {
      const runner = new RecordingRunner([
        result({
          stdout: "url.https://attacker.example/.insteadof https://github.example/\n",
        }),
      ]);
      const transport = new ProcessGitTransport(runner);

      await expect(
        transport.fetch({
          cloneUrl,
          checkoutPath,
          credential: { username: "x-access-token", password: "installation-secret" },
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ operation: "fetch", message: "Git fetch failed." });
      expect(runner.requests).toHaveLength(1);
      expect(runner.requests[0]?.env.CODEM_GIT_PASSWORD).toBeUndefined();
    },
  );

  test(
    "resolves a remote branch to a commit before a hook-safe detached checkout",
    async () => {
      const runner = new RecordingRunner([
        result({ exitCode: 1 }),
        result({ stdout: "abc123def456\n" }),
        result(),
      ]);
      const transport = new ProcessGitTransport(runner);

      const commit = await transport.checkoutRef(
        checkoutPath,
        "release/v1",
        new AbortController().signal,
      );

      expect(commit).toBe("abc123def456");
      expect(runner.requests.map((request) => request.args)).toEqual([
        hookSafeArgs([
          "-C",
          checkoutPath,
          "rev-parse",
          "--verify",
          "refs/remotes/origin/release/v1^{commit}",
        ]),
        hookSafeArgs([
          "-C",
          checkoutPath,
          "rev-parse",
          "--verify",
          "refs/tags/release/v1^{commit}",
        ]),
        hookSafeArgs(["-C", checkoutPath, "checkout", "--detach", "abc123def456"]),
      ]);
    },
  );
});
