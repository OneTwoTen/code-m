import type { GitHubAppConfig } from "../config.ts";
import type { GitHubConnectionProvider } from "../create-server.ts";
import { GitHubAppClient, type GitHubConnectionStatus } from "./github-app.ts";
import type { GitHubConfigStore } from "./github-config-store.ts";

function fingerprint(config: GitHubAppConfig): string {
  return `${config.apiUrl}\u0000${config.appId}\u0000${config.installationId}\u0000${config.privateKey}`;
}

export class DatabaseBackedGitHubProvider implements GitHubConnectionProvider {
  readonly #environment?: GitHubAppConfig;
  readonly #store: GitHubConfigStore;
  #cached?: { fingerprint: string; client: GitHubAppClient };

  constructor(environment: GitHubAppConfig | undefined, store: GitHubConfigStore) {
    this.#environment = environment;
    this.#store = store;
  }

  invalidate(): void {
    this.#cached = undefined;
  }

  resolveConfig(): GitHubAppConfig | undefined {
    return this.#environment ?? this.#store.load();
  }

  async getConnectionStatus(): Promise<GitHubConnectionStatus> {
    const config = this.resolveConfig();
    if (!config) return { configured: false, authenticated: false, reachable: false };
    const key = fingerprint(config);
    if (!this.#cached || this.#cached.fingerprint !== key) {
      this.#cached = { fingerprint: key, client: new GitHubAppClient(config) };
    }
    return this.#cached.client.getConnectionStatus();
  }
}
