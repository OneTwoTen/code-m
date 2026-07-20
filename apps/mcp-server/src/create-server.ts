import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ProcessRunner } from "@codem/core";
import { CodeMError } from "@codem/core";
import { executeTerminal, readWorkspaceFile } from "./tool-handlers.ts";

export interface CodeMServerDependencies {
  workspaceRoot: string;
  processRunner: ProcessRunner;
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

export function createCodeMServer(dependencies: CodeMServerDependencies): McpServer {
  const server = new McpServer(
    {
      name: "code-m",
      version: "0.1.0",
    },
    {
      instructions:
        "Use workspace.read_file for bounded source reads. Use terminal.exec only for non-interactive commands and pass arguments separately from the executable.",
    },
  );

  server.registerTool(
    "system.info",
    {
      title: "CodeM system information",
      description: "Return the CodeM MVP version, runtime, workspace, and available capability summary.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async () => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              name: "code-m",
              version: "0.1.0",
              runtime: `Bun ${Bun.version}`,
              workspaceRoot: dependencies.workspaceRoot,
              capabilities: ["workspace.read_file", "terminal.exec"],
            },
            null,
            2,
          ),
        },
      ],
    }),
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
    async ({ path, maxBytes }) => {
      try {
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
