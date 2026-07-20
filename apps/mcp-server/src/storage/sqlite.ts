import { mkdir } from "node:fs/promises";
import { Database } from "bun:sqlite";

export interface CodeMDatabase {
  database: Database;
  close(): void;
}

const migrations = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS oauth_clients (
        client_id TEXT PRIMARY KEY,
        redirect_uris TEXT NOT NULL,
        client_name TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS authorization_codes (
        code_hash TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        redirect_uri TEXT NOT NULL,
        resource TEXT NOT NULL,
        scopes TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS access_tokens (
        token_hash TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        resource TEXT NOT NULL,
        scopes TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT
      );

      CREATE TABLE IF NOT EXISTS refresh_tokens (
        token_hash TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        resource TEXT NOT NULL,
        scopes TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        replaced_by_hash TEXT
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        encrypted_value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS github_installations (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        account_login TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS connected_repositories (
        id TEXT PRIMARY KEY,
        installation_id TEXT NOT NULL REFERENCES github_installations(id) ON DELETE CASCADE,
        full_name TEXT NOT NULL,
        default_branch TEXT NOT NULL,
        private INTEGER NOT NULL,
        UNIQUE (installation_id, full_name)
      );

      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        repository TEXT NOT NULL,
        ref TEXT NOT NULL,
        path TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (user_id, repository, ref)
      );
    `,
  },
] as const;

function sqlitePath(databaseUrl: string): string {
  if (!databaseUrl.startsWith("file:")) {
    throw new Error(
      "Only SQLite file: URLs are implemented. PostgreSQL is an optional future adapter.",
    );
  }
  const path = databaseUrl.slice("file:".length);
  if (!path) throw new Error("CODEM_DATABASE_URL must include a SQLite file path.");
  return path;
}

export async function openCodeMDatabase(
  databaseUrl: string,
  dataDir: string,
): Promise<CodeMDatabase> {
  await mkdir(dataDir, { recursive: true });
  const database = new Database(sqlitePath(databaseUrl), { create: true, strict: true });

  try {
    database.run("PRAGMA journal_mode = WAL");
    database.run("PRAGMA foreign_keys = ON");
    database.run("PRAGMA busy_timeout = 5000");
    database.run(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
    `);

    const applied = new Set(
      database
        .query("SELECT version FROM schema_migrations")
        .all()
        .map((row) => (row as { version: number }).version),
    );

    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      const apply = database.transaction(() => {
        database.run(migration.sql);
        database.run("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", [
          migration.version,
          new Date().toISOString(),
        ]);
      });
      apply();
    }
  } catch (error) {
    database.close();
    throw error;
  }

  return {
    database,
    close: () => database.close(),
  };
}
