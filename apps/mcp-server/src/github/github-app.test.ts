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

function pendingFetch(): typeof fetch {
  return ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) {
        reject(new Error("expected an abort signal"));
        return;
      }
      const rejectFromSignal = () =>
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      if (signal.aborted) rejectFromSignal();
      else signal.addEventListener("abort", rejectFromSignal, { once: true });
    })) as typeof fetch;
}

function installationTokenResponse(token = "installation-secret-token"): Response {
  return Response.json({
    token,
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    permissions: { contents: "write" },
    repository_selection: "selected",
  });
}

describe("GitHubAppClient", () => {
  test("returns a safe status when the GitHub API times out", async () => {
    const client = new GitHubAppClient(config(), pendingFetch(), 5);

    const status = await client.getConnectionStatus();

    expect(status.reachable).toBe(false);
    expect(status.authenticated).toBe(false);
    expect(status.error).toBe("GitHub request timed out.");
    expect(JSON.stringify(status)).not.toContain("Bearer");
  });

  test("lists installation repositories with a self-contained opaque pagination cursor", async () => {
    const requests: Array<{ url: string; authorization?: string | undefined }> = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({
        url,
        authorization: new Headers(init?.headers).get("authorization") ?? undefined,
      });
      if (url.endsWith("/access_tokens")) return installationTokenResponse();
      const page = new URL(url).searchParams.get("page");
      if (page === "1") {
        return Response.json({
          total_count: 2,
          repositories: [
            {
              id: 1,
              full_name: "owner/one",
              private: true,
              default_branch: "main",
              clone_url: "https://github.test/owner/one.git",
              permissions: { pull: true, push: false },
            },
          ],
        });
      }
      if (page === "2") {
        return Response.json({
          total_count: 2,
          repositories: [
            {
              id: 2,
              full_name: "owner/two",
              private: false,
              default_branch: "trunk",
              clone_url: "https://github.test/owner/two.git",
              permissions: { pull: true, push: true },
            },
          ],
        });
      }
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;
    const client = new GitHubAppClient(config(), fetchFn);

    const first = await client.listRepositories({ limit: 1 });
    expect(first.repositories).toEqual([
      {
        fullName: "owner/one",
        private: true,
        defaultBranch: "main",
        permissions: { pull: true, push: false },
      },
    ]);
    expect(first.nextCursor).toBeString();
    expect(JSON.stringify(first)).not.toContain("installation-secret-token");
    expect(JSON.stringify(first)).not.toContain("clone_url");
    expect(JSON.stringify(first)).not.toContain(".git");

    const second = await client.listRepositories({ cursor: first.nextCursor });
    expect(second.repositories[0]?.fullName).toBe("owner/two");
    expect(second.nextCursor).toBeUndefined();
    expect(requests.some((request) => request.url.includes("per_page=1&page=2"))).toBe(true);
    expect(
      requests.filter((request) => request.url.includes("/installation/repositories"))[0]
        ?.authorization,
    ).toBe("Bearer installation-secret-token");
  });

  test("rejects a limit that conflicts with the opaque repository cursor", async () => {
    let repositoryRequests = 0;
    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/access_tokens")) return installationTokenResponse();
      repositoryRequests += 1;
      return Response.json({
        total_count: 2,
        repositories: [
          {
            id: repositoryRequests,
            full_name: `owner/repository-${repositoryRequests}`,
            private: false,
            default_branch: "main",
          },
        ],
      });
    }) as typeof fetch;
    const client = new GitHubAppClient(config(), fetchFn);

    const first = await client.listRepositories({ limit: 1 });
    expect(first.nextCursor).toBeString();
    await expect(
      client.listRepositories({ cursor: first.nextCursor, limit: 2 }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(repositoryRequests).toBe(1);
  });

  test("rejects malformed repository cursors before making a repository request", async () => {
    let repositoryRequests = 0;
    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/access_tokens")) return installationTokenResponse();
      repositoryRequests += 1;
      return Response.json({ total_count: 0, repositories: [] });
    }) as typeof fetch;
    const client = new GitHubAppClient(config(), fetchFn);

    await expect(client.listRepositories({ cursor: "not-a-valid-cursor" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(repositoryRequests).toBe(0);
  });

  test("returns credential-free clone metadata for an authorized repository", async () => {
    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/access_tokens")) return installationTokenResponse();
      if (url.endsWith("/repos/owner/private")) {
        return Response.json({
          id: 99,
          full_name: "owner/private",
          private: true,
          default_branch: "main",
          clone_url: "https://github.test/owner/private.git",
          permissions: { pull: true, push: false },
        });
      }
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;
    const client = new GitHubAppClient(config(), fetchFn);

    const repository = await client.getRepository("owner/private");

    expect(repository).toEqual({
      fullName: "owner/private",
      private: true,
      defaultBranch: "main",
      cloneUrl: "https://github.test/owner/private.git",
      permissions: { pull: true, push: false },
    });
    expect(JSON.stringify(repository)).not.toContain("installation-secret-token");
  });

  test("maps installation token authentication failures to a stable safe error", async () => {
    const fetchFn = (async () =>
      new Response("remote secret body", { status: 401 })) as typeof fetch;
    const client = new GitHubAppClient(config(), fetchFn);

    await expect(client.listRepositories()).rejects.toMatchObject({
      code: "REPOSITORY_ACCESS_DENIED",
      message: "The GitHub App installation could not authenticate.",
    });
    await client.listRepositories().catch((error: unknown) => {
      expect(String(error)).not.toContain("remote secret body");
    });
  });

  test("maps repository access denial to a stable error without response-body leakage", async () => {
    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/access_tokens")) return installationTokenResponse("do-not-leak");
      return new Response("remote secret body", { status: 403 });
    }) as typeof fetch;
    const client = new GitHubAppClient(config(), fetchFn);

    await expect(client.getRepository("owner/denied")).rejects.toMatchObject({
      code: "REPOSITORY_ACCESS_DENIED",
      message: "The GitHub App installation cannot access the requested repository.",
    });
    await client.getRepository("owner/denied").catch((error: unknown) => {
      expect(String(error)).not.toContain("do-not-leak");
      expect(String(error)).not.toContain("remote secret body");
    });
  });
});
