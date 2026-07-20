import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunProcessRunner } from "@codem/adapters";
import { executeTerminal, readWorkspaceFile } from "./tool-handlers.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function createWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "codem-server-"));
  temporaryDirectories.push(workspace);
  await writeFile(join(workspace, "hello.txt"), "hello from CodeM\n");
  return workspace;
}

describe("readWorkspaceFile", () => {
  test("reads a bounded text file inside the workspace", async () => {
    const workspace = await createWorkspace();

    const result = await readWorkspaceFile(workspace, "hello.txt", 1024);

    expect(result.content).toBe("hello from CodeM\n");
    expect(result.truncated).toBe(false);
  });

  test("rejects traversal outside the workspace", async () => {
    const workspace = await createWorkspace();

    await expect(readWorkspaceFile(workspace, "../outside.txt", 1024)).rejects.toMatchObject({
      code: "PATH_OUTSIDE_WORKSPACE",
    });
  });
});

describe("executeTerminal", () => {
  test("executes a non-interactive command in the workspace", async () => {
    const workspace = await createWorkspace();

    const result = await executeTerminal(
      new BunProcessRunner(),
      workspace,
      {
        command: process.execPath,
        args: ["-e", "console.log('mcp-terminal-ok')"],
        cwd: ".",
        timeoutMs: 5_000,
      },
      new AbortController().signal,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("mcp-terminal-ok");
  });
});
