import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const temporaryDirectories: string[] = [];
const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function createConnectedClient() {
  const workspace = await mkdtemp(join(tmpdir(), "codem-e2e-"));
  temporaryDirectories.push(workspace);
  await writeFile(join(workspace, "sample.txt"), "CodeM stdio works\n");

  const environment = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  environment.CODEM_WORKSPACE_ROOT = workspace;

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["apps/mcp-server/src/main.ts"],
    cwd: process.cwd(),
    env: environment,
    stderr: "pipe",
  });
  const client = new Client({ name: "codem-e2e", version: "0.1.0" });
  clients.push(client);
  await client.connect(transport);

  return { client, workspace };
}

describe("CodeM stdio MVP", () => {
  test("lists and calls the core tools", async () => {
    const { client } = await createConnectedClient();

    const toolList = await client.listTools();
    expect(toolList.tools.map((tool) => tool.name).sort()).toEqual([
      "system.info",
      "terminal.exec",
      "workspace.read_file",
    ]);

    const readResult = await client.callTool({
      name: "workspace.read_file",
      arguments: { path: "sample.txt" },
    });
    expect(readResult.isError).not.toBe(true);
    expect(JSON.stringify(readResult.content)).toContain("CodeM stdio works");

    const terminalResult = await client.callTool({
      name: "terminal.exec",
      arguments: {
        command: process.execPath,
        args: ["-e", "console.log('terminal-e2e-ok')"],
      },
    });
    expect(terminalResult.isError).not.toBe(true);
    expect(JSON.stringify(terminalResult.content)).toContain("terminal-e2e-ok");
  });
});
