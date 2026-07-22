import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ProcessRunner } from "@codem/core";
import { CodeMError } from "@codem/core";
import { CODEM_APPLICATION, runtimeVersion } from "./application-metadata.ts";
import type {
  GitHubConnectionStatus,
  RepositoryListInput,
  RepositoryPage,
} from "./github/github-app.ts";
import { executeTerminal, readWorkspaceFile } from "./tool-handlers.ts";
import type {
  OpenRepositoryInput,
  OpenRepositoryResult,
} from "./workspace/repository-workspace-service.ts";

export interface GitHubConnectionProvider {
  getConnectionStatus(): Promise<GitHubConnectionStatus>;
}

export interface GitHubRepositoryProvider extends GitHubConnectionProvider {
  listRepositories(input: RepositoryListInput): Promise<RepositoryPage>;
}

export interface WorkspaceRepositoryProvider {
  openRepository(input: OpenRepositoryInput, signal: AbortSignal): Promise<OpenRepositoryResult>;
  resolveWorkspaceRoot(userId: string, workspaceId: string): Promise<string>;
}

export interface CodeMServerDependencies {
  workspaceRoot: string;
  processRunner: ProcessRunner;
  remoteMode?: boolean | undefined;
  allowRemoteTerminal?: boolean | undefined;
  github?: GitHubRepositoryProvider | undefined;
  repositoryWorkspaces?: WorkspaceRepositoryProvider | undefined;
}

interface ToolAuthExtra {
  authInfo?:
    | {
        scopes: string[];
        extra?: Record<string, unknown> | undefined;
      }
    | undefined;
}

function errorResult(error: unknown) {
  const message =
    error instanceof CodeMError
      ? `${error.code}: ${error.message}`
      : error instanceof Error
        ? error.message
        : "Unknown tool error.";

  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

function requireScope(
  dependencies: CodeMServerDependencies,
  extra: ToolAuthExtra,
  scope: string,
): void {
  if (!dependencies.remoteMode) return;
  if (!extra.authInfo?.scopes.includes(scope)) {
    throw new CodeMError("MISSING_SCOPE", `Missing required scope: ${scope}`);
  }
}

function requireSubject(dependencies: CodeMServerDependencies, extra: ToolAuthExtra): string {
  if (!dependencies.remoteMode) return "local";
  const subject = extra.authInfo?.extra?.subject;
  if (typeof subject !== "string" || !subject.trim()) {
    throw new CodeMError(
      "AUTH_SUBJECT_REQUIRED",
      "The access token must contain a stable authenticated subject.",
    );
  }
  return subject;
}

async function workspaceRootForRead(
  dependencies: CodeMServerDependencies,
  extra: ToolAuthExtra,
  workspaceId: string | undefined,
): Promise<string> {
  if (!dependencies.remoteMode && workspaceId === undefined) return dependencies.workspaceRoot;
  if (!workspaceId) {
    throw new CodeMError("INVALID_INPUT", "workspaceId is required in HTTP mode.");
  }
  if (!dependencies.repositoryWorkspaces) {
    throw new CodeMError(
      "GITHUB_NOT_CONFIGURED",
      "Repository workspaces are not configured on this server.",
    );
  }
  return dependencies.repositoryWorkspaces.resolveWorkspaceRoot(
    requireSubject(dependencies, extra),
    workspaceId,
  );
}

export function createCodeMServer(dependencies: CodeMServerDependencies): McpServer {
  const server = new McpServer(CODEM_APPLICATION, {
    instructions:
      "Use repository.list and workspace.open_repository to obtain a workspaceId. Pass workspaceId to workspace.read_file in HTTP mode. Use terminal.exec only for non-interactive commands and pass arguments separately from the executable.",
  });

  server.registerTool(
    "system.info",
    {
      title: "CodeM system information",
      description:
        "Return the CodeM version, runtime, workspace, and available capability summary.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (_input, extra) => {
      try {
        requireScope(dependencies, extra, "codem:read");
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  ...CODEM_APPLICATION,
                  runtime: runtimeVersion(),
                  transport: dependencies.remoteMode ? "http" : "stdio",
                  workspaceRoot: dependencies.remoteMode ? undefined : dependencies.workspaceRoot,
                  capabilities: [
                    "workspace.read_file",
                    "workspace.open_repository",
                    "repository.list",
                    "terminal.exec",
                    "github.connection_status",
                  ],
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "repository.list",
    {
      title: "List GitHub repositories",
      description:
        "List repositories authorized for the configured GitHub App installation without exposing clone credentials.",
      inputSchema: {
        cursor: z.string().min(1).optional().describe("Opaque cursor returned by a previous call."),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ cursor, limit }, extra) => {
      try {
        requireScope(dependencies, extra, "codem:read");
        if (!dependencies.github) {
          throw new CodeMError("GITHUB_NOT_CONFIGURED", "GitHub App access is not configured.");
        }
        const result = await dependencies.github.listRepositories({ cursor, limit });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "workspace.open_repository",
    {
      title: "Open repository workspace",
      description:
        "Clone or safely update one authorized GitHub repository and return a persistent workspaceId.",
      inputSchema: {
        repository: z.string().min(1).describe("Canonical owner/name repository identifier."),
        ref: z
          .string()
          .min(1)
          .optional()
          .describe("Branch, tag, or commit. Defaults to the repository default branch."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ repository, ref }, extra) => {
      try {
        requireScope(dependencies, extra, "codem:workspace");
        if (!dependencies.repositoryWorkspaces) {
          throw new CodeMError(
            "GITHUB_NOT_CONFIGURED",
            "Repository workspaces are not configured on this server.",
          );
        }
        const result = await dependencies.repositoryWorkspaces.openRepository(
          {
            userId: requireSubject(dependencies, extra),
            repository,
            ref,
          },
          extra.signal,
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "workspace.read_file",
    {
      title: "Read workspace file",
      description: "Read a bounded UTF-8 text file located inside the authorized workspace.",
      inputSchema: {
        workspaceId: z.string().min(1).optional().describe("Persistent workspace identifier."),
        path: z.string().min(1).describe("Workspace-relative file path."),
        maxBytes: z.number().int().positive().max(262_144).optional(),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async ({ workspaceId, path, maxBytes }, extra) => {
      try {
        requireScope(dependencies, extra, "codem:read");
        const workspaceRoot = await workspaceRootForRead(dependencies, extra, workspaceId);
        const result = await readWorkspaceFile(workspaceRoot, path, maxBytes);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "github.connection_status",
    {
      title: "GitHub connection status",
      description:
        "Check whether the server-side GitHub App installation is configured, authenticated, and able to list repositories.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (_input, extra) => {
      try {
        requireScope(dependencies, extra, "codem:read");
        const status = dependencies.github
          ? await dependencies.github.getConnectionStatus()
          : { configured: false, authenticated: false, reachable: false };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(status, null, 2) }],
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "terminal.exec",
    {
      title: "Execute terminal command",
      description:
        "Run one non-interactive executable inside the authorized workspace. Arguments are passed without shell parsing.",
      inputSchema: {
        command: z.string().min(1),
        args: z.array(z.string()).max(128).optional(),
        cwd: z.string().optional().describe("Workspace-relative working directory."),
        timeoutMs: z.number().int().positive().max(120_000).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async ({ command, args, cwd, timeoutMs }, extra) => {
      try {
        requireScope(dependencies, extra, "codem:execute");
        if (dependencies.remoteMode && !dependencies.allowRemoteTerminal) {
          throw new Error("Remote terminal execution is disabled by server policy.");
        }
        const result = await executeTerminal(
          dependencies.processRunner,
          dependencies.workspaceRoot,
          { command, args, cwd, timeoutMs },
          extra.signal,
        );

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
          isError: result.exitCode !== 0,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  return server;
}
