import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ProcessRunner } from "@codem/core";
import { CodeMError } from "@codem/core";
import { CODEM_APPLICATION, runtimeVersion } from "./application-metadata.ts";
import type { GitHubConnectionStatus } from "./github/github-app.ts";
import { executeTerminal, readWorkspaceFile } from "./tool-handlers.ts";

export interface GitHubConnectionProvider {
  getConnectionStatus(): Promise<GitHubConnectionStatus>;
}

export interface CodeMServerDependencies {
  workspaceRoot: string;
  processRunner: ProcessRunner;
  remoteMode?: boolean;
  allowRemoteTerminal?: boolean;
  github?: GitHubConnectionProvider;
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
  extra: { authInfo?: { scopes: string[] } },
  scope: string,
): void {
  if (!dependencies.remoteMode) return;
  if (!extra.authInfo?.scopes.includes(scope)) {
    throw new Error(`Missing required scope: ${scope}`);
  }
}

export function createCodeMServer(dependencies: CodeMServerDependencies): McpServer {
  const server = new McpServer(CODEM_APPLICATION, {
    instructions:
      "Use workspace.read_file for bounded source reads. Use terminal.exec only for non-interactive commands and pass arguments separately from the executable.",
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
                  workspaceRoot: dependencies.workspaceRoot,
                  capabilities: [
                    "workspace.read_file",
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
    "workspace.read_file",
    {
      title: "Read workspace file",
      description: "Read a bounded UTF-8 text file located inside the authorized workspace.",
      inputSchema: {
        path: z.string().min(1).describe("Workspace-relative file path."),
        maxBytes: z.number().int().positive().max(262_144).optional(),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async ({ path, maxBytes }, extra) => {
      try {
        requireScope(dependencies, extra, "codem:read");
        const result = await readWorkspaceFile(dependencies.workspaceRoot, path, maxBytes);
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
