import { createSign } from "node:crypto";
import type { GitHubAppConfig } from "../config.ts";

interface InstallationTokenResponse {
  token: string;
  expires_at: string;
  permissions?: Record<string, string>;
  repository_selection?: string;
}

interface InstallationRepositoriesResponse {
  total_count: number;
  repositories: Array<{
    id: number;
    full_name: string;
    private: boolean;
    default_branch: string;
  }>;
}

interface CachedToken {
  token: string;
  expiresAt: number;
  permissions: Record<string, string>;
  repositorySelection: string;
}

export interface GitHubConnectionStatus {
  configured: boolean;
  authenticated: boolean;
  reachable: boolean;
  installationId?: string;
  repositorySelection?: string;
  permissions?: Record<string, string>;
  repositoryCount?: number;
  repositories?: Array<{
    id: number;
    fullName: string;
    private: boolean;
    defaultBranch: string;
  }>;
  error?: string;
}

function base64Url(value: string | Uint8Array): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return Buffer.from(bytes).toString("base64url");
}

export function createGitHubAppJwt(config: GitHubAppConfig, now = Date.now()): string {
  const issuedAt = Math.floor(now / 1000) - 60;
  const expiresAt = issuedAt + 9 * 60;
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({ iat: issuedAt, exp: expiresAt, iss: config.appId }),
  );
  const unsigned = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  return `${unsigned}.${base64Url(signer.sign(config.privateKey))}`;
}

export class GitHubAppClient {
  readonly #config: GitHubAppConfig;
  readonly #fetch: typeof fetch;
  #cached?: CachedToken;

  constructor(config: GitHubAppConfig, fetchFn: typeof fetch = fetch) {
    this.#config = config;
    this.#fetch = fetchFn;
  }

  async #installationToken(): Promise<CachedToken> {
    const now = Date.now();
    if (this.#cached && this.#cached.expiresAt - 60_000 > now) return this.#cached;

    const jwt = createGitHubAppJwt(this.#config, now);
    const response = await this.#fetch(
      `${this.#config.apiUrl}/app/installations/${this.#config.installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${jwt}`,
          "x-github-api-version": "2026-03-10",
        },
      },
    );
    if (!response.ok) throw new Error(`GitHub installation token request failed (${response.status}).`);

    const result = (await response.json()) as InstallationTokenResponse;
    this.#cached = {
      token: result.token,
      expiresAt: Date.parse(result.expires_at),
      permissions: result.permissions ?? {},
      repositorySelection: result.repository_selection ?? "unknown",
    };
    return this.#cached;
  }

  async getConnectionStatus(): Promise<GitHubConnectionStatus> {
    try {
      const installation = await this.#installationToken();
      const response = await this.#fetch(`${this.#config.apiUrl}/installation/repositories?per_page=20`, {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${installation.token}`,
          "x-github-api-version": "2026-03-10",
        },
      });
      if (!response.ok) throw new Error(`GitHub repository request failed (${response.status}).`);

      const result = (await response.json()) as InstallationRepositoriesResponse;
      return {
        configured: true,
        authenticated: true,
        reachable: true,
        installationId: this.#config.installationId,
        repositorySelection: installation.repositorySelection,
        permissions: installation.permissions,
        repositoryCount: result.total_count,
        repositories: result.repositories.slice(0, 20).map((repository) => ({
          id: repository.id,
          fullName: repository.full_name,
          private: repository.private,
          defaultBranch: repository.default_branch,
        })),
      };
    } catch (error) {
      return {
        configured: true,
        authenticated: false,
        reachable: false,
        installationId: this.#config.installationId,
        error: error instanceof Error ? error.message : "GitHub connection failed.",
      };
    }
  }
}
