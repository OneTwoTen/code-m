import { realpath } from "node:fs/promises";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BunProcessRunner } from "@codem/adapters";
import { createCodeMServer } from "./create-server.ts";

async function main(): Promise<void> {
  const configuredWorkspace = process.env.CODEM_WORKSPACE_ROOT ?? process.cwd();
  const workspaceRoot = await realpath(configuredWorkspace);
  const server = createCodeMServer({
    workspaceRoot,
    processRunner: new BunProcessRunner(),
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`CodeM MCP server 0.1.0 running for workspace: ${workspaceRoot}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(`CodeM failed to start: ${message}`);
  process.exit(1);
});
