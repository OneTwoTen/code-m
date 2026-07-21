import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export class CodeMError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CodeMError";
  }
}

function assertInsideWorkspace(workspaceRoot: string, candidate: string): void {
  const relativePath = relative(workspaceRoot, candidate);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new CodeMError("PATH_OUTSIDE_WORKSPACE", "Path is outside the authorized workspace.");
  }
}

export async function resolveWorkspacePath(
  workspaceRoot: string,
  requestedPath: string,
): Promise<string> {
  if (requestedPath.includes("\0")) {
    throw new CodeMError("INVALID_INPUT", "Path contains a null byte.");
  }

  if (isAbsolute(requestedPath)) {
    throw new CodeMError("PATH_OUTSIDE_WORKSPACE", "Absolute paths are not allowed.");
  }

  const canonicalRoot = await realpath(workspaceRoot);
  const candidate = resolve(canonicalRoot, requestedPath || ".");
  assertInsideWorkspace(canonicalRoot, candidate);

  const canonicalCandidate = await realpath(candidate);
  assertInsideWorkspace(canonicalRoot, canonicalCandidate);
  return canonicalCandidate;
}
