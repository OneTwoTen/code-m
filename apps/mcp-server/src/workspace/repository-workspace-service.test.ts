import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitHubRepository } from "../github/github-app.ts";
import type {
  CreateWorkspaceInput,
  UpdateWorkspaceLifecycleInput,
  WorkspaceRecord,
  WorkspaceStore,
} from "./workspace-store.ts";
import type { GitCloneInput, GitFetchInput, GitTransport } from "./git-transport.ts";
import { GitRefNotFoundError, GitTransportError } from "./git-transport.ts";
import { RepositoryWorkspaceService } from "./repository-workspace-service.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

class MemoryWorkspaceStore implements WorkspaceStore {
  readonly rows = new Map<string, WorkspaceRecord>();

  async create(input: CreateWorkspaceInput): Promise<WorkspaceRecord> {
    const row: WorkspaceRecord = {
      id: input.id,
      userId: input.userId,
      repositoryFullName: input.repositoryFullName,
      ref: input.ref,
      checkoutPath: input.checkoutPath,
      status: input.status,
      createdAt: input.now,
      updatedAt: input.now,
      lastOpenedAt: input.now,
    };
    this.rows.set(row.id, row);
    return row;
  }

  async findByRepository(
    userId: string,
    repositoryFullName: string,
    ref: string,
  ): Promise<WorkspaceRecord | undefined> {
    return [...this.rows.values()].find(
      (row) =>
        row.userId === userId && row.repositoryFullName === repositoryFullName && row.ref === ref,
    );
  }

  async getById(userId: string, workspaceId: string): Promise<WorkspaceRecord | undefined> {
    const row = this.rows.get(workspaceId);
    return row?.userId === userId ? row : undefined;
  }

  async updateLifecycle(
    userId: string,
    workspaceId: string,
    input: UpdateWorkspaceLifecycleInput,
  ): Promise<WorkspaceRecord> {
    const existing = await this.getById(userId, workspaceId);
    if (!existing) throw new Error("workspace not found");
    const updated: WorkspaceRecord = {
      ...existing,
      status: input.status,
      updatedAt: input.now,
      lastOpenedAt: input.openedAt ?? existing.lastOpenedAt,
      ...(input.lastError === undefined ? {} : { lastError: input.lastError }),
    };
    if (input.lastError === undefined) delete updated.lastError;
    this.rows.set(workspaceId, updated);
    return updated;
  }
}

class FakeGitHubProvider {
  readonly repository: GitHubRepository = {
    fullName: "owner/repository",
    defaultBranch: "main",
    private: true,
    cloneUrl: "https://github.example/owner/repository.git",
    permissions: { pull: true, push: false },
  };
  token = "installation-secret";

  async getRepository(fullName: string): Promise<GitHubRepository> {
    if (fullName !== this.repository.fullName) throw new Error("unexpected repository");
    return this.repository;
  }

  async withInstallationToken<T>(operation: (token: string) => Promise<T>): Promise<T> {
    return operation(this.token);
  }
}

class FakeGitTransport implements GitTransport {
  cloneCalls = 0;
  fetchCalls = 0;
  checkoutCalls = 0;
  dirty = false;
  cloneError: Error | undefined;
  checkoutError: Error | undefined;
  fetchGate: Promise<void> | undefined;

  async clone(input: GitCloneInput): Promise<void> {
    this.cloneCalls += 1;
    if (this.cloneError) throw this.cloneError;
    await mkdir(input.checkoutPath, { recursive: true });
    await writeFile(join(input.checkoutPath, "README.md"), "repository readme\n");
  }

  async fetch(_input: GitFetchInput): Promise<void> {
    this.fetchCalls += 1;
    if (this.fetchGate) await this.fetchGate;
  }

  async isDirty(): Promise<boolean> {
    return this.dirty;
  }

  async checkoutRef(): Promise<string> {
    this.checkoutCalls += 1;
    if (this.checkoutError) throw this.checkoutError;
    return "abc123def456";
  }
}

async function fixture() {
  const workspacesDir = await mkdtemp(join(tmpdir(), "codem-repository-workspaces-"));
  temporaryDirectories.push(workspacesDir);
  const store = new MemoryWorkspaceStore();
  const github = new FakeGitHubProvider();
  const git = new FakeGitTransport();
  let sequence = 0;
  const service = new RepositoryWorkspaceService({
    workspacesDir,
    store,
    github,
    git,
    createId: () => `ws_test_${++sequence}`,
    now: () => `2026-07-22T03:0${sequence}:00.000Z`,
  });
  return { workspacesDir, store, github, git, service };
}

describe("RepositoryWorkspaceService", () => {
  test("opens the default branch under an opaque persistent workspace path", async () => {
    const { workspacesDir, store, github, git, service } = await fixture();

    const opened = await service.openRepository(
      { userId: "usr_one", repository: "owner/repository" },
      new AbortController().signal,
    );

    expect(opened).toEqual({
      workspaceId: "ws_test_1",
      repository: "owner/repository",
      ref: "main",
      status: "ready",
      reused: false,
    });
    const row = store.rows.get(opened.workspaceId);
    expect(row).toMatchObject({ status: "ready", ref: "main" });
    expect(row?.lastError).toBeUndefined();
    expect(row?.checkoutPath).toBe(join(workspacesDir, "ws_test_1", "repository"));
    expect(JSON.stringify(opened)).not.toContain(github.token);
    expect(git.cloneCalls).toBe(1);
    expect(git.checkoutCalls).toBe(1);
    await expect(access(join(row?.checkoutPath ?? "", "README.md"))).resolves.toBeUndefined();
  });

  test("reuses and updates a clean workspace for the same repository and ref", async () => {
    const { git, service } = await fixture();
    const signal = new AbortController().signal;
    const first = await service.openRepository(
      { userId: "usr_one", repository: "owner/repository", ref: "release/v1" },
      signal,
    );
    const second = await service.openRepository(
      { userId: "usr_one", repository: "owner/repository", ref: "release/v1" },
      signal,
    );

    expect(second.workspaceId).toBe(first.workspaceId);
    expect(second.reused).toBe(true);
    expect(git.cloneCalls).toBe(1);
    expect(git.fetchCalls).toBe(1);
  });

  test("does not fetch or overwrite a dirty workspace", async () => {
    const { git, service } = await fixture();
    const signal = new AbortController().signal;
    await service.openRepository({ userId: "usr_one", repository: "owner/repository" }, signal);
    git.dirty = true;

    await expect(
      service.openRepository({ userId: "usr_one", repository: "owner/repository" }, signal),
    ).rejects.toMatchObject({ code: "WORKSPACE_DIRTY" });
    expect(git.fetchCalls).toBe(0);
  });

  test("marks failed partial clones recoverably and removes the partial checkout", async () => {
    const { store, git, service } = await fixture();
    git.cloneError = new GitTransportError("clone", "Git clone failed.");

    await expect(
      service.openRepository(
        { userId: "usr_one", repository: "owner/repository" },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "WORKSPACE_CREATE_FAILED" });

    const row = [...store.rows.values()][0];
    expect(row).toMatchObject({
      status: "failed",
      lastError: "Repository workspace could not be created.",
    });
    await expect(access(row?.checkoutPath ?? "")).rejects.toBeDefined();
  });

  test("maps an unresolved branch, tag, or commit to INVALID_REF", async () => {
    const { store, git, service } = await fixture();
    git.checkoutError = new GitRefNotFoundError();

    await expect(
      service.openRepository(
        { userId: "usr_one", repository: "owner/repository", ref: "missing-ref" },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "INVALID_REF" });
    expect([...store.rows.values()][0]?.status).toBe("failed");
  });

  test("serializes concurrent updates for one user, repository, and ref", async () => {
    const { git, service } = await fixture();
    const signal = new AbortController().signal;
    await service.openRepository({ userId: "usr_one", repository: "owner/repository" }, signal);

    let releaseFetch: (() => void) | undefined;
    git.fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const first = service.openRepository(
      { userId: "usr_one", repository: "owner/repository" },
      signal,
    );
    const second = service.openRepository(
      { userId: "usr_one", repository: "owner/repository" },
      signal,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(git.fetchCalls).toBe(1);

    releaseFetch?.();
    await first;
    git.fetchGate = undefined;
    await second;
    expect(git.fetchCalls).toBe(2);
  });

  test("resolves ready workspaces only for their authenticated owner", async () => {
    const { service } = await fixture();
    const opened = await service.openRepository(
      { userId: "usr_owner", repository: "owner/repository" },
      new AbortController().signal,
    );

    expect(await service.resolveWorkspaceRoot("usr_owner", opened.workspaceId)).toContain(
      opened.workspaceId,
    );
    await expect(
      service.resolveWorkspaceRoot("usr_other", opened.workspaceId),
    ).rejects.toMatchObject({ code: "WORKSPACE_NOT_FOUND" });
  });

  test("rejects malformed repository names and refs before touching Git", async () => {
    const { git, service } = await fixture();
    const signal = new AbortController().signal;

    await expect(
      service.openRepository({ userId: "usr_one", repository: "../escape" }, signal),
    ).rejects.toMatchObject({ code: "INVALID_REPOSITORY" });
    await expect(
      service.openRepository(
        { userId: "usr_one", repository: "owner/repository", ref: "--upload-pack=evil" },
        signal,
      ),
    ).rejects.toMatchObject({ code: "INVALID_REF" });
    expect(git.cloneCalls).toBe(0);
  });
});
