# GitHub Repository Preview Metadata Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make bounded repository previews from `github.connection_status` explicitly report truncation and point coding agents to the existing read-only `repository.list` pagination flow.

**Architecture:** Add a small pure annotation function at the database-backed GitHub provider boundary. It enriches successful connection status responses using already-returned `repositoryCount` and preview entries, so no extra GitHub API request is needed. Keep `repository.list`, its opaque cursor, and scope enforcement unchanged.

**Tech Stack:** TypeScript, Bun test, existing MCP server and GitHub App provider.

## Global Constraints

- Keep `github.connection_status` bounded.
- Preserve all existing connection-status fields.
- Complete repository discovery must require only `codem:read`.
- Do not execute shell commands or require `codem:execute`.
- Do not expose GitHub installation tokens, clone credentials, or raw upstream bodies.

---

### Task 1: Add repository preview metadata

**Files:**
- Modify: `apps/mcp-server/src/github/github-provider.ts`

**Interfaces:**
- Consumes: `GitHubConnectionStatus` containing optional `repositoryCount` and `repositories`.
- Produces: the same status plus optional `repositoryPreviewCount`, `repositoriesTruncated`, and `repositoryListingTool`.

- [x] **Step 1: Add a pure `annotateRepositoryPreview` helper.**
- [x] **Step 2: Leave statuses without `repositoryCount` unchanged.**
- [x] **Step 3: Derive preview count from the bounded repository array.**
- [x] **Step 4: Mark previews truncated only when preview count is below total count.**
- [x] **Step 5: Identify `repository.list` as the complete discovery tool.**
- [x] **Step 6: Apply the helper to `DatabaseBackedGitHubProvider.getConnectionStatus`.**

### Task 2: Add focused regression tests

**Files:**
- Create: `apps/mcp-server/src/github/github-provider.test.ts`

**Interfaces:**
- Consumes: `annotateRepositoryPreview`.
- Produces: regression coverage for truncated, complete, and failed status responses.

- [x] **Step 1: Test 45 total repositories with a 20-item preview.**
- [x] **Step 2: Test a complete preview that is not truncated.**
- [x] **Step 3: Test that unreachable status does not invent metadata.**

### Task 3: Document complete repository discovery

**Files:**
- Create: `docs/github-repository-discovery.md`

**Interfaces:**
- Consumes: status metadata and the existing `repository.list` cursor contract.
- Produces: an actionable 20 + 20 + 5 example for 45 repositories.

- [x] **Step 1: Explain that `github.connection_status.repositories` is a preview.**
- [x] **Step 2: Document the new metadata fields.**
- [x] **Step 3: Show repeated `repository.list` calls until `nextCursor` is absent.**
- [x] **Step 4: State that `codem:execute`, `terminal.exec`, and `gh` are unnecessary.**

### Task 4: Verify and open the pull request

**Files:**
- Review: all branch changes.

- [x] **Step 1: Remove temporary files and stale assumptions from the branch.**
- [x] **Step 2: Compare the branch against `main` and review the final diff.**
- [x] **Step 3: Run repository checks through the configured CI workflow.**
- [x] **Step 4: Open a pull request that closes issue #6 and reports verification status.**
