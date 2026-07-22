import { createSign } from "node:crypto";
import { CodeMError } from "@codem/core";
import type { GitHubAppConfig } from "../config.ts";
import { fetchWithTimeout, OutboundHttpTimeoutError } from "../http/fetch-with-timeout.ts";

interface InstallationTokenResponse {
  token: string;
  expires_at: string;
  permissions?: Record<string, string>;
  repository_selection?: string;
}

interface GitHubApiRepository {
  id: number;
  full_name: string;
  private: boolean;
  default_branch: string;
  clone_url?: string;
  permissions?: {
    pull?: boolean;
    push?: boolean;
  };
}

interface InstallationRepositoriesResponse {
  total_count: number;
  repositories: GitHubApiRepository[];
}

interface CachedToken {
  token: string;
  expiresAt: number;
  permissions: Record<string, string>;
  repositorySelection: string;
}

interface RepositoryCursor {
  page: number;
  limit: number;
}

export interface GitHubRepositorySummary {
  fullName: string;
  defaultBranch: string;
  private: boolean;
  permissions?: {
    pull: boolean;
    push: boolean;
  };
}

export interface GitHubRepository extends GitHubRepositorySummary {
  cloneUrl: string;
}

export interface RepositoryListInput {
  cursor?: string | undefined;
  limit?: number | undefined;
}

export interface RepositoryPage {
  repositories: GitHubRepositorySummary[];
  nextCursor?: string | undefined;
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

function repositoryPermissions(repository: GitHubApiRepository) {
  if (!repository.permissions) return undefined;
  return {
    pull: repository.permissions.pull === true,
    push: repository.permissions.push === true,
  };
}

function repositorySummary(repository: GitHubApiRepository): GitHubRepositorySummary {
  const permissions = repositoryPermissions(repository);
  return {
    fullName: repository.full_name,
    private: repository.private,
    defaultBranch: repository.default_branch,
    ...(permissions ? { permissions } : {}),
  };
}

const CURSOR_PREFIX = "ghrepo_";

function boundedLimit(value: number | undefined): number {
  const limit = value ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new CodeMError("INVALID_INPUT", "Repository limit must be an integer between 1 and 100.");
  }
  return limit;
}

function encodeCursor(page: number, limit: number): string {
  return `${CURSOR_PREFIX}${base64Url(JSON.stringify({ page, limit }))}`;
}

function decodeCursor(cursor: string): RepositoryCursor {
  if (!cursor.startsWith(CURSOR_PREFIX)) {
    throw new CodeMError("INVALID_INPUT", "Repository cursor is invalid.");
  }
  try {
    const encoded = cursor.slice(CURSOR_PREFIX.length);
    const decoded = Buffer.from(encoded, "base64url").toString("utf8");
    const parsed = JSON.parse(decoded) as Partial<RepositoryCursor>;
    const page = parsed.page;
    const limit = parsed.limit;
    if (
      !Number.isInteger(page) ||
      typeof page !== "number" ||
      page < 1 ||
      !Number.isInteger(limit) ||
      typeof limit !== "number" ||
      limit < 1 ||
      limit > 100 ||
      encodeCursor(page, limit) !== cursor
    ) {
      throw new Error("invalid cursor");
    }
    return { page, limit };
  } catch {
    throw new CodeMError("INVALID_INPUT", "Repository cursor is invalid.");
  }
}

function repositoryPagination(input: RepositoryListInput): RepositoryCursor {
  if (!input.cursor) return { page: 1, limit: boundedLimit(input.limit) };
  const decoded = decodeCursor(input.cursor);
  if (input.limit !== undefined && boundedLimit(input.limit) !== decoded.limit) {
    throw new CodeMError("INVALID_INPUT", "Repository limit must match the opaque cursor.");
  }
  return decoded;
}

export function createGitHubAppJwt(config: GitHubAppConfig, now = Date.now()): string {
  const issuedAt = Math.floor(now / 1000) - 60;
  const expiresAt = issuedAt + 9 * 60;
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({ iat: issuedAt, exp: expiresAt, iss: config.appId }));
  const unsigned = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  return `${unsigned}.${base64Url(signer.sign(config.privateKey))}`;
}

export class GitHubAppClient {
  readonly #config: GitHubAppConfig;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  #cached?: CachedToken;

  constructor(config: GitHubAppConfig, fetchFn: typeof fetch = fetch, timeoutMs = 10_000) {
    this.#config = config;
    this.#fetch = fetchFn;
    this.#timeoutMs = timeoutMs;
  }

  async #request(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    return fetchWithTimeout(this.#fetch, input, init, this.#timeoutMs);
  }

  async #installationToken(): Promise<CachedToken> {
    const now = Date.now();
    if (this.#cached && this.#cached.expiresAt - 60_000 > now) return this.#cached;

    const jwt = createGitHubAppJwt(this.#config, now);
    const response = await this.#request(
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
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      throw new CodeMError(
        "REPOSITORY_ACCESS_DENIED",
        "The GitHub App installation could not authenticate.",
      );
    }
    if (!response.ok) {
      throw new Error(`GitHub installation token request failed (${response.status}).`);
    }

    const result = (await response.json()) as InstallationTokenResponse;
    this.#cached = {
      token: result.token,
      expiresAt: Date.parse(result.expires_at),
      permissions: result.permissions ?? {},
      repositorySelection: result.repository_selection ?? "unknown",
    };
    return this.#cached;
  }

  async withInstallationToken<T>(operation: (token: string) => Promise<T>): Promise<T> {
    const installation = await this.#installationToken();
    return operation(installation.token);
  }

  async listRepositories(input: RepositoryListInput = {}): Promise<RepositoryPage> {
    const { page, limit } = repositoryPagination(input);
    try {
      return await this.withInstallationToken(async (token) => {
        const url = new URL(`${this.#config.apiUrl}/installation/repositories`);
        url.searchParams.set("per_page", String(limit));
        url.searchParams.set("page", String(page));
        const response = await this.#request(url, {
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${token}`,
            "x-github-api-version": "2026-03-10",
          },
        });
        if (response.status === 401 || response.status === 403) {
          throw new CodeMError(
            "REPOSITORY_ACCESS_DENIED",
            "The GitHub App installation cannot list repositories.",
          );
        }
        if (!response.ok) {
          throw new Error(`GitHub repository request failed (${response.status}).`);
        }

        const result = (await response.json()) as InstallationRepositoriesResponse;
        const nextCursor =
          page * limit < result.total_count ? encodeCursor(page + 1, limit) : undefined;
        return {
          repositories: result.repositories.map(repositorySummary),
          ...(nextCursor ? { nextCursor } : {}),
        };
      });
    } catch (error) {
      if (error instanceof OutboundHttpTimeoutError) {
        throw new CodeMError("REPOSITORY_ACCESS_DENIED", "GitHub repository request timed out.");
      }
      throw error;
    }
  }

  async getRepository(fullName: string): Promise<GitHubRepository> {
    try {
      return await this.withInstallationToken(async (token) => {
        const [owner, name] = fullName.split("/");
        const url = `${this.#config.apiUrl}/repos/${encodeURIComponent(owner ?? "")}/${encodeURIComponent(name ?? "")}`;
        const response = await this.#request(url, {
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${token}`,
            "x-github-api-version": "2026-03-10",
          },
        });
        if (response.status === 403 || response.status === 401) {
          throw new CodeMError(
            "REPOSITORY_ACCESS_DENIED",
            "The GitHub App installation cannot access the requested repository.",
          );
        }
        if (response.status === 404) {
          throw new CodeMError("REPOSITORY_NOT_FOUND", "The requested repository was not found.");
        }
        if (!response.ok) {
          throw new Error(`GitHub repository lookup failed (${response.status}).`);
        }

        const repository = (await response.json()) as GitHubApiRepository;
        if (!repository.clone_url || !repository.clone_url.startsWith("https://")) {
          throw new Error("GitHub repository metadata did not include a safe HTTPS clone URL.");
        }
        return {
          ...repositorySummary(repository),
          cloneUrl: repository.clone_url,
        };
      });
    } catch (error) {
      if (error instanceof OutboundHttpTimeoutError) {
        throw new CodeMError("REPOSITORY_ACCESS_DENIED", "GitHub repository request timed out.");
      }
      throw error;
    }
  }

  async getConnectionStatus(): Promise<GitHubConnectionStatus> {
    try {
      const installation = await this.#installationToken();
      const response = await this.#request(
        `${this.#config.apiUrl}/installation/repositories?per_page=20`,
        {
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${installation.token}`,
            "x-github-api-version": "2026-03-10",
          },
        },
      );
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
        error:
          error instanceof OutboundHttpTimeoutError
            ? "GitHub request timed out."
            : error instanceof Error
              ? error.message
              : "GitHub connection failed.",
      };
    }
  }
}
