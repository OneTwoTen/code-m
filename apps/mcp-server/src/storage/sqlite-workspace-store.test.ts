import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteWorkspaceStore } from "./sqlite-workspace-store.ts";
import { openCodeMDatabase } from "./sqlite.ts";

const temporaryDirectories: string[] = [];
const closeDatabase: Array<() => void> = [];

afterEach(async () => {
  for (const close of closeDatabase.splice(0)) close();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function openFixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "codem-workspace-store-"));
  temporaryDirectories.push(dataDir);
  const databaseUrl = `file:${join(dataDir, "codem.sqlite")}`;
  const storage = await openCodeMDatabase(databaseUrl, dataDir);
  closeDatabase.push(storage.close);
  for (const [id, username] of [
    ["usr_one", "one"],
    ["usr_owner", "owner"],
    ["usr_other", "other"],
  ] as const) {
    storage.database.run(
      `INSERT INTO users (id, username, password_hash, role, created_at)
       VALUES (?, ?, ?, 'user', ?)`,
      [id, username, "test-password-hash", "2026-07-22T03:00:00.000Z"],
    );
  }
  return { dataDir, databaseUrl, storage, store: new SQLiteWorkspaceStore(storage.database) };
}

describe("SQLiteWorkspaceStore", () => {
  test("persists workspace metadata across a database reopen", async () => {
    const fixture = await openFixture();
    const created = await fixture.store.create({
      id: "ws_persisted",
      userId: "usr_one",
      repositoryFullName: "OneTwoTen/code-m",
      ref: "main",
      checkoutPath: join(fixture.dataDir, "workspaces", "ws_persisted", "repository"),
      status: "creating",
      now: "2026-07-22T03:00:00.000Z",
    });

    expect(created).toMatchObject({
      id: "ws_persisted",
      repositoryFullName: "OneTwoTen/code-m",
      status: "creating",
      lastError: undefined,
      lastOpenedAt: "2026-07-22T03:00:00.000Z",
    });

    fixture.storage.close();
    closeDatabase.pop();
    const reopened = await openCodeMDatabase(fixture.databaseUrl, fixture.dataDir);
    closeDatabase.push(reopened.close);
    const store = new SQLiteWorkspaceStore(reopened.database);

    expect(await store.findByRepository("usr_one", "OneTwoTen/code-m", "main")).toEqual(created);
  });

  test("scopes workspace id lookup to the authenticated owner", async () => {
    const fixture = await openFixture();
    await fixture.store.create({
      id: "ws_private",
      userId: "usr_owner",
      repositoryFullName: "owner/private",
      ref: "main",
      checkoutPath: join(fixture.dataDir, "workspaces", "ws_private", "repository"),
      status: "ready",
      now: "2026-07-22T03:00:00.000Z",
    });

    expect(await fixture.store.getById("usr_owner", "ws_private")).toMatchObject({
      id: "ws_private",
      userId: "usr_owner",
    });
    expect(await fixture.store.getById("usr_other", "ws_private")).toBeUndefined();
  });

  test("updates lifecycle state without losing immutable repository metadata", async () => {
    const fixture = await openFixture();
    await fixture.store.create({
      id: "ws_lifecycle",
      userId: "usr_one",
      repositoryFullName: "owner/repository",
      ref: "release/v1",
      checkoutPath: join(fixture.dataDir, "workspaces", "ws_lifecycle", "repository"),
      status: "creating",
      now: "2026-07-22T03:00:00.000Z",
    });

    const failed = await fixture.store.updateLifecycle("usr_one", "ws_lifecycle", {
      status: "failed",
      lastError: "Clone failed safely.",
      now: "2026-07-22T03:01:00.000Z",
      openedAt: "2026-07-22T03:01:00.000Z",
    });

    expect(failed).toMatchObject({
      repositoryFullName: "owner/repository",
      ref: "release/v1",
      status: "failed",
      lastError: "Clone failed safely.",
      updatedAt: "2026-07-22T03:01:00.000Z",
      lastOpenedAt: "2026-07-22T03:01:00.000Z",
    });

    const ready = await fixture.store.updateLifecycle("usr_one", "ws_lifecycle", {
      status: "ready",
      lastError: undefined,
      now: "2026-07-22T03:02:00.000Z",
      openedAt: "2026-07-22T03:02:00.000Z",
    });
    expect(ready.lastError).toBeUndefined();
    expect(ready.status).toBe("ready");
  });
});
