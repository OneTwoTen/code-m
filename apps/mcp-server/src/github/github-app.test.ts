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

describe("GitHubAppClient", () => {
  test("returns a safe status when the GitHub API times out", async () => {
    const client = new GitHubAppClient(config(), pendingFetch(), 5);

    const status = await client.getConnectionStatus();

    expect(status.reachable).toBe(false);
    expect(status.authenticated).toBe(false);
    expect(status.error).toBe("GitHub request timed out.");
    expect(JSON.stringify(status)).not.toContain("Bearer");
  });
});
