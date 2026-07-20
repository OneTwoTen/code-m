import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCodeMDatabase } from "./sqlite.ts";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("openCodeMDatabase", () => {
  test("creates a fresh database, applies migrations, and enables safety pragmas", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "codem-sqlite-"));
    temporaryDirectories.push(dataDir);

    const storage = await openCodeMDatabase(`file:${join(dataDir, "codem.sqlite")}`, dataDir);
    try {
      const foreignKeys = storage.database.query("PRAGMA foreign_keys").get() as {
        foreign_keys: number;
      };
      const busyTimeout = storage.database.query("PRAGMA busy_timeout").get() as {
        timeout: number;
      };
      const migration = storage.database
        .query("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1")
        .get() as { version: number };

      expect(foreignKeys.foreign_keys).toBe(1);
      expect(busyTimeout.timeout).toBe(5000);
      expect(migration.version).toBeGreaterThan(0);
    } finally {
      storage.close();
    }
  });

  test("keeps data after reopening and migrations remain idempotent", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "codem-sqlite-"));
    temporaryDirectories.push(dataDir);
    const databaseUrl = `file:${join(dataDir, "codem.sqlite")}`;

    const first = await openCodeMDatabase(databaseUrl, dataDir);
    first.database.run(
      "INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)",
      ["user_1", "admin", "hash", "admin", new Date().toISOString()],
    );
    first.close();

    const second = await openCodeMDatabase(databaseUrl, dataDir);
    try {
      const user = second.database
        .query("SELECT username FROM users WHERE id = ?")
        .get("user_1") as {
        username: string;
      };
      expect(user.username).toBe("admin");
    } finally {
      second.close();
    }
  });
});
