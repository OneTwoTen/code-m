export type WorkspaceStatus = "creating" | "ready" | "updating" | "failed";

export interface WorkspaceRecord {
  id: string;
  userId: string;
  repositoryFullName: string;
  ref: string;
  checkoutPath: string;
  status: WorkspaceStatus;
  lastError?: string | undefined;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string;
}

export interface CreateWorkspaceInput {
  id: string;
  userId: string;
  repositoryFullName: string;
  ref: string;
  checkoutPath: string;
  status: WorkspaceStatus;
  now: string;
}

export interface UpdateWorkspaceLifecycleInput {
  status: WorkspaceStatus;
  lastError?: string | undefined;
  now: string;
  openedAt?: string | undefined;
}

export interface WorkspaceStore {
  create(input: CreateWorkspaceInput): Promise<WorkspaceRecord>;
  findByRepository(
    userId: string,
    repositoryFullName: string,
    ref: string,
  ): Promise<WorkspaceRecord | undefined>;
  getById(userId: string, workspaceId: string): Promise<WorkspaceRecord | undefined>;
  updateLifecycle(
    userId: string,
    workspaceId: string,
    input: UpdateWorkspaceLifecycleInput,
  ): Promise<WorkspaceRecord>;
}
