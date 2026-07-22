import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import type { GitHubAppConfig } from "../config.ts";
import { GitHubAppClient } from "./github-app.ts";

function config(): GitHubAppConfig {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return {
    appId: "123",
    installationId: "456",
    apiUrl: "https://api.github.test",
    privateKey,
  };
}

function installationTokenResponse(): Response {
  return Response.json({
    token: "installation-secret-token",
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    permissions: { contents: "read" },
    repository_selection: "selected",
  });
}

function repositories(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    full_name: `owner/repository-${index + 1}`,
    private: index % 2 === 0,
    default_branch: "main",
  }));
}

function statusFetch(totalCount: number, previewCount: number): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/access_tokens")) return installationTokenResponse();
    if (url.includes("/installation/repositories?per_page=20")) {
      return Response.json({
        total_count: totalCount,
        repositories: repositories(previewCount),
      });
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
}

describe("GitHubAppClient connection status", () => {
  test("marks a 20-item preview of 45 repositories as truncated", async () => {
    const client = new GitHubAppClient(config(), statusFetch(45, 20));

    const status = await client.getConnectionStatus();

    expect(status).toMatchObject({
      repositoryCount: 45,
      repositoryPreviewCount: 20,
      repositoriesTruncated: true,
      repositoryListingTool: "repository.list",
    });
    expect(status.repositories).toHaveLength(20);
    expect(JSON.stringify(status)).not.toContain("installation-secret-token");
  });

  test("marks a complete repository preview as not truncated", async () => {
    const client = new GitHubAppClient(config(), statusFetch(3, 3));

    const status = await client.getConnectionStatus();

    expect(status).toMatchObject({
      repositoryCount: 3,
      repositoryPreviewCount: 3,
      repositoriesTruncated: false,
      repositoryListingTool: "repository.list",
    });
  });
});
