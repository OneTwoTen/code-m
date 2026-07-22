import { describe, expect, test } from "bun:test";
import type { GitHubConnectionStatus } from "./github-app.ts";
import { annotateRepositoryPreview } from "./github-provider.ts";

function repositoryPreview(count: number): NonNullable<GitHubConnectionStatus["repositories"]> {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    fullName: `owner/repository-${index + 1}`,
    private: index % 2 === 0,
    defaultBranch: "main",
  }));
}

describe("annotateRepositoryPreview", () => {
  test("marks a 20-item preview of 45 repositories as truncated", () => {
    const status = annotateRepositoryPreview({
      configured: true,
      authenticated: true,
      reachable: true,
      repositoryCount: 45,
      repositories: repositoryPreview(20),
    });

    expect(status).toMatchObject({
      repositoryCount: 45,
      repositoryPreviewCount: 20,
      repositoriesTruncated: true,
      repositoryListingTool: "repository.list",
    });
    expect(status.repositories).toHaveLength(20);
  });

  test("marks a complete repository preview as not truncated", () => {
    const status = annotateRepositoryPreview({
      configured: true,
      authenticated: true,
      reachable: true,
      repositoryCount: 3,
      repositories: repositoryPreview(3),
    });

    expect(status).toMatchObject({
      repositoryPreviewCount: 3,
      repositoriesTruncated: false,
      repositoryListingTool: "repository.list",
    });
  });

  test("does not invent repository metadata for an unreachable status", () => {
    const status = annotateRepositoryPreview({
      configured: true,
      authenticated: false,
      reachable: false,
      error: "GitHub request timed out.",
    });

    expect(status).toEqual({
      configured: true,
      authenticated: false,
      reachable: false,
      error: "GitHub request timed out.",
    });
  });
});
