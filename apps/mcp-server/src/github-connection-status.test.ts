import { afterEach, describe, expect, test } from "bun:test";
import { BunProcessRunner } from "@codem/adapters";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createCodeMServer } from "./create-server.ts";
import type {
  GitHubConnectionStatus,
  RepositoryListInput,
  RepositoryPage,
} from "./github/github-app.ts";

const clients: Client[] = [];
const servers: Array<ReturnType<typeof createCodeMServer>> = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function textContent(result: unknown): string {
  const contents = (result as { content?: unknown }).content;
  if (!Array.isArray(contents)) throw new Error("expected MCP content array");
  const content = contents[0] as { type?: unknown; text?: unknown } | undefined;
  if (content?.type !== "text" || typeof content.text !== "string") {
    throw new Error("expected MCP text content");
  }
  return content.text;
}

class FakeGitHubProvider {
  async getConnectionStatus(): Promise<GitHubConnectionStatus> {
    return {
      configured: true,
      authenticated: true,
      reachable: true,
      repositoryCount: 45,
      repositories: Array.from({ length: 20 }, (_, index) => ({
        id: index + 1,
        fullName: `owner/repository-${index + 1}`,
        private: false,
        defaultBranch: "main",
      })),
      repositoryPreviewCount: 20,
      repositoriesTruncated: true,
      repositoryListingTool: "repository.list",
    };
  }

  async listRepositories(_input: RepositoryListInput): Promise<RepositoryPage> {
    return { repositories: [] };
  }
}

describe("github.connection_status MCP tool", () => {
  test("serializes actionable repository preview metadata", async () => {
    const server = createCodeMServer({
      workspaceRoot: process.cwd(),
      processRunner: new BunProcessRunner(),
      github: new FakeGitHubProvider(),
    });
    const client = new Client({ name: "codem-status-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    clients.push(client);
    servers.push(server);

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "github.connection_status",
      arguments: {},
    });

    expect(result.isError).not.toBe(true);
    expect(JSON.parse(textContent(result))).toMatchObject({
      repositoryCount: 45,
      repositoryPreviewCount: 20,
      repositoriesTruncated: true,
      repositoryListingTool: "repository.list",
    });
  });
});
