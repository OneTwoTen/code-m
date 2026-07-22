import { mkdir, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { CodeMError } from "@codem/core";
import type { GitHubRepository } from "../github/github-app.ts";
import type { GitTransport } from "./git-transport.ts";
import { GitRefNotFoundError } from "./git-transport.ts";
import type { WorkspaceRecord, WorkspaceStore } from "./workspace-store.ts";

export interface RepositoryWorkspaceGitHubProvider {
  getRepository(fullName: string): Promise<GitHubRepository>;
  withInstallationToken<T>(operation: (token: string) => Promise<T>): Promise<T>;
}

export interface OpenRepositoryInput {
  userId: string;
  repository: string;
  ref?: string | undefined;
}

export interface OpenRepositoryResult {
  workspaceId: string;
  repository: string;
  ref: string;
  status: "ready";
  reused: boolean;
}

export interface RepositoryWorkspaceServiceDependencies {
  workspacesDir: string;
  store: WorkspaceStore;
  github: RepositoryWorkspaceGitHubProvider;
  git: GitTransport;
  createId?: (() => string) | undefined;
  now?: (() => string) | undefined;
}

const REPOSITORY_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const WORKSPACE_ID_PATTERN = /^ws_[A-Za-z0-9_-]{1,120}$/;

function validateRepository(value: string): string {
  if (
    value.trim() !== value ||
    !REPOSITORY_PATTERN.test(value) ||
    value.includes("..") ||
    value.endsWith(".git")
  ) {
    throw new CodeMError("INVALID_REPOSITORY", "Repository must use the canonical owner/name form.");
  }
  return value;
}

function validateRef(value: string): string {
  if (
    value.trim() !== value ||
    value.length < 1 ||
    value.length > 255 ||
    value.startsWith("-") ||
    value.startsWith(".") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.endsWith(".lock") ||
    value.includes("..") ||
    value.includes("@{") ||
    /[\u0000-\u0020\u007f~^:?*[\\]/.test(value) ||
    value.includes("//")
  ) {
    throw new CodeMError("INVALID_REF", "Repository ref is invalid.");
  }
  return value;
}

function assertContained(root: string, candidate: string): void {
  const relativePath = relative(root, candidate);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new CodeMError("WORKSPACE_NOT_FOUND", "The requested workspace does not exist.");
  }
}

function defaultWorkspaceId(): string {
  return `ws_${crypto.randomUUID().replaceAll("-", "")}`;
}

export class RepositoryWorkspaceService {
  readonly #workspacesDir: string;
  readonly #store: WorkspaceStore;
  readonly #github: RepositoryWorkspaceGitHubProvider;
  readonly #git: GitTransport;
  readonly #createId: () => string;
  readonly #now: () => string;
  readonly #locks = new Map<string, Promise<void>>();

  constructor(dependencies: RepositoryWorkspaceServiceDependencies) {
    this.#workspacesDir = resolve(dependencies.workspacesDir);
    this.#store = dependencies.store;
    this.#github = dependencies.github;
    this.#git = dependencies.git;
    this.#createId = dependencies.createId ?? defaultWorkspaceId;
    this.#now = dependencies.now ?? (() => new Date().toISOString());
  }

  async #withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(key) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const tail = previous.then(
      () => gate,
      () => gate,
    );
    this.#locks.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release?.();
      if (this.#locks.get(key) === tail) this.#locks.delete(key);
    }
  }

  #checkoutPath(workspaceId: string): string {
    if (!WORKSPACE_ID_PATTERN.test(workspaceId)) {
      throw new CodeMError("WORKSPACE_NOT_FOUND", "The requested workspace does not exist.");
    }
    const checkoutPath = resolve(join(this.#workspacesDir, workspaceId, "repository"));
    assertContained(this.#workspacesDir, checkoutPath);
    return checkoutPath;
  }

  async #markFailed(
    workspace: WorkspaceRecord,
    message: string,
    cleanupCheckout: boolean,
  ): Promise<void> {
    if (cleanupCheckout) {
      await rm(workspace.checkoutPath, { recursive: true, force: true }).catch(() => undefined);
    }
    await this.#store
      .updateLifecycle(workspace.userId, workspace.id, {
        status: "failed",
        lastError: message,
        now: this.#now(),
      })
      .catch(() => undefined);
  }

  async #createWorkspace(
    workspace: WorkspaceRecord,
    repository: GitHubRepository,
    signal: AbortSignal,
  ): Promise<OpenRepositoryResult> {
    try {
      await rm(workspace.checkoutPath, { recursive: true, force: true });
      await mkdir(resolve(workspace.checkoutPath, ".."), { recursive: true });
      await this.#github.withInstallationToken((token) =>
        this.#git.clone({
          cloneUrl: repository.cloneUrl,
          checkoutPath: workspace.checkoutPath,
          credential: { username: "x-access-token", password: token },
          signal,
        }),
      );
      await this.#git.checkoutRef(workspace.checkoutPath, workspace.ref, signal);
      await this.#store.updateLifecycle(workspace.userId, workspace.id, {
        status: "ready",
        lastError: undefined,
        now: this.#now(),
        openedAt: this.#now(),
      });
      return {
        workspaceId: workspace.id,
        repository: workspace.repositoryFullName,
        ref: workspace.ref,
        status: "ready",
        reused: false,
      };
    } catch (error) {
      if (error instanceof GitRefNotFoundError) {
        await this.#markFailed(workspace, "Repository ref was not found.", true);
        throw new CodeMError("INVALID_REF", "The requested branch, tag, or commit was not found.");
      }
      await this.#markFailed(workspace, "Repository workspace could not be created.", true);
      throw new CodeMError(
        "WORKSPACE_CREATE_FAILED",
        "Repository workspace could not be created.",
      );
    }
  }

  async #updateWorkspace(
    workspace: WorkspaceRecord,
    signal: AbortSignal,
  ): Promise<OpenRepositoryResult> {
    try {
      if (await this.#git.isDirty(workspace.checkoutPath, signal)) {
        throw new CodeMError(
          "WORKSPACE_DIRTY",
          "The workspace contains local changes and was not updated.",
        );
      }
      await this.#store.updateLifecycle(workspace.userId, workspace.id, {
        status: "updating",
        lastError: undefined,
        now: this.#now(),
      });
      await this.#github.withInstallationToken((token) =>
        this.#git.fetch({
          checkoutPath: workspace.checkoutPath,
          credential: { username: "x-access-token", password: token },
          signal,
        }),
      );
      await this.#git.checkoutRef(workspace.checkoutPath, workspace.ref, signal);
      await this.#store.updateLifecycle(workspace.userId, workspace.id, {
        status: "ready",
        lastError: undefined,
        now: this.#now(),
        openedAt: this.#now(),
      });
      return {
        workspaceId: workspace.id,
        repository: workspace.repositoryFullName,
        ref: workspace.ref,
        status: "ready",
        reused: true,
      };
    } catch (error) {
      if (error instanceof CodeMError && error.code === "WORKSPACE_DIRTY") throw error;
      if (error instanceof GitRefNotFoundError) {
        await this.#markFailed(workspace, "Repository ref was not found.", false);
        throw new CodeMError("INVALID_REF", "The requested branch, tag, or commit was not found.");
      }
      await this.#markFailed(workspace, "Repository workspace could not be updated.", false);
      throw new CodeMError(
        "WORKSPACE_UPDATE_FAILED",
        "Repository workspace could not be updated.",
      );
    }
  }

  async openRepository(
    input: OpenRepositoryInput,
    signal: AbortSignal,
  ): Promise<OpenRepositoryResult> {
    const repositoryName = validateRepository(input.repository);
    const repository = await this.#github.getRepository(repositoryName);
    const ref = validateRef(input.ref ?? repository.defaultBranch);
    const lockKey = `${input.userId}\u0000${repository.fullName}\u0000${ref}`;

    return this.#withLock(lockKey, async () => {
      const existing = await this.#store.findByRepository(input.userId, repository.fullName, ref);
      if (existing?.status === "ready" || existing?.status === "updating") {
        return this.#updateWorkspace(existing, signal);
      }

      let workspace = existing;
      if (workspace) {
        workspace = await this.#store.updateLifecycle(input.userId, workspace.id, {
          status: "creating",
          lastError: undefined,
          now: this.#now(),
          openedAt: this.#now(),
        });
      } else {
        const workspaceId = this.#createId();
        const checkoutPath = this.#checkoutPath(workspaceId);
        workspace = await this.#store.create({
          id: workspaceId,
          userId: input.userId,
          repositoryFullName: repository.fullName,
          ref,
          checkoutPath,
          status: "creating",
          now: this.#now(),
        });
      }
      return this.#createWorkspace(workspace, repository, signal);
    });
  }

  async resolveWorkspaceRoot(userId: string, workspaceId: string): Promise<string> {
    if (!WORKSPACE_ID_PATTERN.test(workspaceId)) {
      throw new CodeMError("WORKSPACE_NOT_FOUND", "The requested workspace does not exist.");
    }
    const workspace = await this.#store.getById(userId, workspaceId);
    if (!workspace || workspace.status !== "ready") {
      throw new CodeMError("WORKSPACE_NOT_FOUND", "The requested workspace does not exist.");
    }

    const configuredPath = resolve(workspace.checkoutPath);
    assertContained(this.#workspacesDir, configuredPath);
    try {
      const canonicalRoot = await realpath(this.#workspacesDir);
      const canonicalCheckout = await realpath(configuredPath);
      assertContained(canonicalRoot, canonicalCheckout);
      return canonicalCheckout;
    } catch (error) {
      if (error instanceof CodeMError) throw error;
      throw new CodeMError("WORKSPACE_NOT_FOUND", "The requested workspace does not exist.");
    }
  }
}
