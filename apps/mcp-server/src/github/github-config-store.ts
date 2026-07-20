import { createHash, randomBytes } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { GitHubAppConfig } from "../config.ts";
import { SecretBox } from "./secret-box.ts";

const CONFIG_KEY = "github.app.config";

export interface StoredGitHubConfig extends GitHubAppConfig {
  clientId?: string;
  clientSecret?: string;
  webhookSecret?: string;
}

interface PersistedGitHubConfig {
  appId: string;
  privateKey: string;
  installationId: string;
  apiUrl: string;
  clientId?: string;
  clientSecret?: string;
  webhookSecret?: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

export class GitHubConfigStore {
  readonly #database: Database;
  readonly #box: SecretBox;

  constructor(database: Database, secretKey: string) {
    this.#database = database;
    this.#box = new SecretBox(secretKey);
  }

  load(): StoredGitHubConfig | undefined {
    const row = this.#database.query("SELECT encrypted_value FROM settings WHERE key = ?").get(CONFIG_KEY) as
      | { encrypted_value: string }
      | null;
    if (!row) return undefined;
    const value = JSON.parse(this.#box.decrypt(row.encrypted_value)) as PersistedGitHubConfig;
    if (!value.appId || !value.privateKey || !value.installationId || !value.apiUrl) return undefined;
    return value;
  }

  save(config: StoredGitHubConfig): void {
    const encrypted = this.#box.encrypt(JSON.stringify(config));
    this.#database.run(
      "INSERT INTO settings (key, encrypted_value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET encrypted_value = excluded.encrypted_value, updated_at = excluded.updated_at",
      [CONFIG_KEY, encrypted, new Date().toISOString()],
    );
  }

  disconnect(): void {
    this.#database.run("DELETE FROM settings WHERE key = ?", [CONFIG_KEY]);
  }

  createState(sessionHash: string, purpose: "manifest" | "install", ttlMs = 10 * 60 * 1000): string {
    const state = randomToken();
    this.#database.run(
      "INSERT INTO github_setup_states (state_hash, session_hash, purpose, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
      [
        sha256(state),
        sessionHash,
        purpose,
        new Date(Date.now() + ttlMs).toISOString(),
        new Date().toISOString(),
      ],
    );
    return state;
  }

  consumeState(state: string, sessionHash: string, purpose: "manifest" | "install"): boolean {
    const stateHash = sha256(state);
    const consume = this.#database.transaction(() => {
      const row = this.#database
        .query(
          "SELECT state_hash FROM github_setup_states WHERE state_hash = ? AND session_hash = ? AND purpose = ? AND consumed_at IS NULL AND expires_at > ?",
        )
        .get(stateHash, sessionHash, purpose, new Date().toISOString()) as { state_hash: string } | null;
      if (!row) return false;
      this.#database.run("UPDATE github_setup_states SET consumed_at = ? WHERE state_hash = ?", [
        new Date().toISOString(),
        stateHash,
      ]);
      return true;
    });
    return consume();
  }
}
