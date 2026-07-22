import type { Database } from "bun:sqlite";
import { CodeMError } from "@codem/core";
import type {
  CreateWorkspaceInput,
  UpdateWorkspaceLifecycleInput,
  WorkspaceRecord,
  WorkspaceStatus,
  WorkspaceStore,
} from "../workspace/workspace-store.ts";

interface WorkspaceRow {
  id: string;
  user_id: string;
  repository_full_name: string;
  ref: string;
  checkout_path: string;
  status: WorkspaceStatus;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  last_opened_at: string;
}

function toRecord(row: WorkspaceRow): WorkspaceRecord {
  return {
    id: row.id,
    userId: row.user_id,
    repositoryFullName: row.repository_full_name,
    ref: row.ref,
    checkoutPath: row.checkout_path,
    status: row.status,
    ...(row.last_error === null ? {} : { lastError: row.last_error }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastOpenedAt: row.last_opened_at,
  };
}

export class SQLiteWorkspaceStore implements WorkspaceStore {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  async create(input: CreateWorkspaceInput): Promise<WorkspaceRecord> {
    this.#database.run(
      `INSERT INTO workspaces (
        id, user_id, repository_full_name, ref, checkout_path, status,
        last_error, created_at, updated_at, last_opened_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      [
        input.id,
        input.userId,
        input.repositoryFullName,
        input.ref,
        input.checkoutPath,
        input.status,
        input.now,
        input.now,
        input.now,
      ],
    );

    const created = await this.getById(input.userId, input.id);
    if (!created) throw new Error("Workspace row was not created.");
    return created;
  }

  async findByRepository(
    userId: string,
    repositoryFullName: string,
    ref: string,
  ): Promise<WorkspaceRecord | undefined> {
    const row = this.#database
      .query(
        `SELECT id, user_id, repository_full_name, ref, checkout_path, status,
          last_error, created_at, updated_at, last_opened_at
         FROM workspaces
         WHERE user_id = ? AND repository_full_name = ? AND ref = ?`,
      )
      .get(userId, repositoryFullName, ref) as WorkspaceRow | null;
    return row ? toRecord(row) : undefined;
  }

  async getById(userId: string, workspaceId: string): Promise<WorkspaceRecord | undefined> {
    const row = this.#database
      .query(
        `SELECT id, user_id, repository_full_name, ref, checkout_path, status,
          last_error, created_at, updated_at, last_opened_at
         FROM workspaces
         WHERE user_id = ? AND id = ?`,
      )
      .get(userId, workspaceId) as WorkspaceRow | null;
    return row ? toRecord(row) : undefined;
  }

  async updateLifecycle(
    userId: string,
    workspaceId: string,
    input: UpdateWorkspaceLifecycleInput,
  ): Promise<WorkspaceRecord> {
    this.#database.run(
      `UPDATE workspaces
       SET status = ?, last_error = ?, updated_at = ?,
           last_opened_at = COALESCE(?, last_opened_at)
       WHERE user_id = ? AND id = ?`,
      [
        input.status,
        input.lastError ?? null,
        input.now,
        input.openedAt ?? null,
        userId,
        workspaceId,
      ],
    );

    const updated = await this.getById(userId, workspaceId);
    if (!updated) {
      throw new CodeMError("WORKSPACE_NOT_FOUND", "The requested workspace does not exist.");
    }
    return updated;
  }
}
