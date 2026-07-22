import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ProcessExecutionResult, ProcessRunner } from "@codem/core";
import type {
  GitCloneInput,
  GitCredential,
  GitFetchInput,
  GitOperation,
  GitTransport,
} from "./git-transport.ts";
import { GitRefNotFoundError, GitTransportError } from "./git-transport.ts";

const DEFAULT_TIMEOUT_MS = 120_000;
const OUTPUT_LIMIT_BYTES = 64 * 1024;
const TERMINATION_GRACE_MS = 500;
const ASKPASS_SCRIPT = `#!/bin/sh
case "$1" in
  *Username*) printf '%s\\n' "$CODEM_GIT_USERNAME" ;;
  *) printf '%s\\n' "$CODEM_GIT_PASSWORD" ;;
esac
`;

function inheritedEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL"]) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

function assertSafeCloneUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new GitTransportError("clone", "Git clone failed.");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new GitTransportError("clone", "Git clone failed.");
  }
}

function operationMessage(operation: GitOperation): string {
  return `Git ${operation} failed.`;
}

function successful(result: ProcessExecutionResult): boolean {
  return result.exitCode === 0 && !result.timedOut && !result.cancelled;
}

export class ProcessGitTransport implements GitTransport {
  readonly #processRunner: ProcessRunner;
  readonly #gitCommand: string;
  readonly #timeoutMs: number;

  constructor(
    processRunner: ProcessRunner,
    options: { gitCommand?: string; timeoutMs?: number } = {},
  ) {
    this.#processRunner = processRunner;
    this.#gitCommand = options.gitCommand ?? "git";
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async #execute(
    operation: GitOperation,
    args: readonly string[],
    cwd: string,
    signal: AbortSignal,
    environment: Readonly<Record<string, string>> = inheritedEnvironment(),
  ): Promise<ProcessExecutionResult> {
    let result: ProcessExecutionResult;
    try {
      result = await this.#processRunner.execute(
        {
          command: this.#gitCommand,
          args,
          cwd,
          env: environment,
          timeoutMs: this.#timeoutMs,
          stdoutLimitBytes: OUTPUT_LIMIT_BYTES,
          stderrLimitBytes: OUTPUT_LIMIT_BYTES,
          stdinLimitBytes: 0,
          terminationGraceMs: TERMINATION_GRACE_MS,
        },
        {
          requestId: crypto.randomUUID(),
          workspaceRoot: cwd,
          signal,
        },
      );
    } catch {
      throw new GitTransportError(operation, operationMessage(operation));
    }
    return result;
  }

  async #withCredential<T>(
    credential: GitCredential,
    operation: (environment: Readonly<Record<string, string>>) => Promise<T>,
  ): Promise<T> {
    const helperDirectory = await mkdtemp(join(tmpdir(), "codem-git-askpass-"));
    const helperPath = join(helperDirectory, "askpass.sh");
    try {
      await writeFile(helperPath, ASKPASS_SCRIPT, { mode: 0o700 });
      return await operation({
        ...inheritedEnvironment(),
        GIT_ASKPASS: helperPath,
        GIT_TERMINAL_PROMPT: "0",
        CODEM_GIT_USERNAME: credential.username,
        CODEM_GIT_PASSWORD: credential.password,
      });
    } finally {
      await rm(helperDirectory, { recursive: true, force: true });
    }
  }

  async clone(input: GitCloneInput): Promise<void> {
    assertSafeCloneUrl(input.cloneUrl);
    const result = await this.#withCredential(input.credential, (environment) =>
      this.#execute(
        "clone",
        ["clone", "--no-checkout", "--origin", "origin", input.cloneUrl, input.checkoutPath],
        dirname(input.checkoutPath),
        input.signal,
        environment,
      ),
    );
    if (!successful(result)) {
      throw new GitTransportError("clone", operationMessage("clone"));
    }
  }

  async fetch(input: GitFetchInput): Promise<void> {
    const result = await this.#withCredential(input.credential, (environment) =>
      this.#execute(
        "fetch",
        ["-C", input.checkoutPath, "fetch", "--prune", "--tags", "origin"],
        input.checkoutPath,
        input.signal,
        environment,
      ),
    );
    if (!successful(result)) {
      throw new GitTransportError("fetch", operationMessage("fetch"));
    }
  }

  async isDirty(checkoutPath: string, signal: AbortSignal): Promise<boolean> {
    const result = await this.#execute(
      "status",
      ["-C", checkoutPath, "status", "--porcelain=v1", "--untracked-files=normal"],
      checkoutPath,
      signal,
    );
    if (!successful(result)) {
      throw new GitTransportError("status", operationMessage("status"));
    }
    return result.stdout.trim().length > 0;
  }

  async checkoutRef(checkoutPath: string, ref: string, signal: AbortSignal): Promise<string> {
    const candidates = [
      `refs/remotes/origin/${ref}^{commit}`,
      `refs/tags/${ref}^{commit}`,
      `${ref}^{commit}`,
    ];
    let commit: string | undefined;
    for (const candidate of candidates) {
      const resolved = await this.#execute(
        "checkout",
        ["-C", checkoutPath, "rev-parse", "--verify", candidate],
        checkoutPath,
        signal,
      );
      if (!successful(resolved)) continue;
      const value = resolved.stdout.trim();
      if (/^[0-9a-f]{7,64}$/i.test(value)) {
        commit = value;
        break;
      }
    }
    if (!commit) throw new GitRefNotFoundError();

    const checkout = await this.#execute(
      "checkout",
      ["-C", checkoutPath, "checkout", "--detach", commit],
      checkoutPath,
      signal,
    );
    if (!successful(checkout)) {
      throw new GitTransportError("checkout", operationMessage("checkout"));
    }
    return commit;
  }
}
