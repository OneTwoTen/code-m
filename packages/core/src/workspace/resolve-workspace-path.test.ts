import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWorkspacePath } from "./resolve-workspace-path.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function createWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "codem-core-"));
  temporaryDirectories.push(workspace);
  await mkdir(join(workspace, "src"));
  await writeFile(join(workspace, "src", "index.ts"), "export const value = 1;\n");
  return workspace;
}

describe("resolveWorkspacePath", () => {
  test("resolves an existing path inside the workspace", async () => {
    const workspace = await createWorkspace();

    const result = await resolveWorkspacePath(workspace, "src/index.ts");

    expect(result).toBe(join(workspace, "src", "index.ts"));
  });

  test("rejects traversal outside the workspace", async () => {
    const workspace = await createWorkspace();

    await expect(resolveWorkspacePath(workspace, "../outside.txt")).rejects.toMatchObject({
      code: "PATH_OUTSIDE_WORKSPACE",
    });
  });
});
