export interface GitCredential {
  username: string;
  password: string;
}

export interface GitCloneInput {
  cloneUrl: string;
  checkoutPath: string;
  credential: GitCredential;
  signal: AbortSignal;
}

export interface GitFetchInput {
  checkoutPath: string;
  credential: GitCredential;
  signal: AbortSignal;
}

export type GitOperation = "clone" | "fetch" | "status" | "checkout";

export class GitTransportError extends Error {
  constructor(
    public readonly operation: GitOperation,
    message: string,
  ) {
    super(message);
    this.name = "GitTransportError";
  }
}

export class GitRefNotFoundError extends GitTransportError {
  constructor() {
    super("checkout", "Git ref was not found.");
    this.name = "GitRefNotFoundError";
  }
}

export interface GitTransport {
  clone(input: GitCloneInput): Promise<void>;
  fetch(input: GitFetchInput): Promise<void>;
  isDirty(checkoutPath: string, signal: AbortSignal): Promise<boolean>;
  checkoutRef(checkoutPath: string, ref: string, signal: AbortSignal): Promise<string>;
}
