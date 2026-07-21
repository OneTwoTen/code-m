import { realpath } from "node:fs/promises";
import { BunProcessRunner } from "@codem/adapters";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CODEM_APPLICATION } from "./application-metadata.ts";
import { loadCodeMConfig } from "./config.ts";
import { createCodeMServer } from "./create-server.ts";
import { GitHubAppClient } from "./github/github-app.ts";
import { GitHubConfigStore } from "./github/github-config-store.ts";
import { DatabaseBackedGitHubProvider } from "./github/github-provider.ts";
import { GitHubSetupController } from "./github/github-setup-controller.ts";
import { startHttpServer } from "./http-server.ts";
import { openCodeMDatabase } from "./storage/sqlite.ts";

async function main(): Promise<void> {
  const config = loadCodeMConfig();
  const workspaceRoot = await realpath(config.workspaceRoot);
  const processRunner = new BunProcessRunner();

  if (config.transport === "http") {
    const storage = await openCodeMDatabase(config.databaseUrl, config.dataDir);
    const githubStore = new GitHubConfigStore(storage.database, config.secretKey);
    const github = new DatabaseBackedGitHubProvider(
      config.github,
      githubStore,
      config.outboundHttpTimeoutMs,
    );
    const githubSetup = new GitHubSetupController(storage.database, config, githubStore, github);
    const httpServer = startHttpServer(config, {
      workspaceRoot,
      processRunner,
      github,
      githubSetup,
      database: storage.database,
    });
    const close = () => {
      httpServer.stop(true);
      storage.close();
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
    console.error(
      `CodeM MCP server ${CODEM_APPLICATION.version} listening on ${httpServer.hostname}:${httpServer.port}; MCP URL: ${config.mcpUrl.href}`,
    );
    return;
  }

  const github = config.github ? new GitHubAppClient(config.github) : undefined;
  const server = createCodeMServer({ workspaceRoot, processRunner, github });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `CodeM MCP server ${CODEM_APPLICATION.version} running for workspace: ${workspaceRoot}`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(`CodeM failed to start: ${message}`);
  process.exit(1);
});
