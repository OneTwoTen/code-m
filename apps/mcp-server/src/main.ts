import { realpath } from "node:fs/promises";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BunProcessRunner } from "@codem/adapters";
import { loadCodeMConfig } from "./config.ts";
import { createCodeMServer } from "./create-server.ts";
import { GitHubAppClient } from "./github/github-app.ts";
import { startHttpServer } from "./http-server.ts";

async function main(): Promise<void> {
  const config = loadCodeMConfig();
  const workspaceRoot = await realpath(config.workspaceRoot);
  const processRunner = new BunProcessRunner();
  const github = config.github ? new GitHubAppClient(config.github) : undefined;

  if (config.transport === "http") {
    const httpServer = startHttpServer(config, { workspaceRoot, processRunner, github });
    console.error(
      `CodeM MCP server 0.2.0 listening on ${httpServer.hostname}:${httpServer.port} for workspace: ${workspaceRoot}`,
    );
    return;
  }

  const server = createCodeMServer({ workspaceRoot, processRunner, github });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`CodeM MCP server 0.2.0 running for workspace: ${workspaceRoot}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(`CodeM failed to start: ${message}`);
  process.exit(1);
});
