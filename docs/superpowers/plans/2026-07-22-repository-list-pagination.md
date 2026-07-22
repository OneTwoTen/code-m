# GitHub Repository Preview Metadata Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make bounded repository previews from `github.connection_status` explicitly report truncation and point coding agents to the existing read-only `repository.list` pagination flow.

**Architecture:** Extend the canonical `GitHubConnectionStatus` contract and compute preview metadata inside `GitHubAppClient.getConnectionStatus()`. Both stdio and HTTP composition paths use this client contract, while `DatabaseBackedGitHubProvider` remains a pass-through. Keep `repository.list`, its opaque cursor, and scope enforcement unchanged.

**Tech Stack:** TypeScript, Bun test, MCP SDK in-memory transport, existing GitHub App client and provider.

## Global Constraints

- Keep `github.connection_status` bounded.
- Preserve all existing connection-status fields.
- Complete repository discovery must require only `codem:read`.
- Do not execute shell commands or require `codem:execute`.
- Do not expose GitHub installation tokens, clone credentials, or raw upstream bodies.
- Return identical preview metadata in stdio and HTTP modes.

---

### Task 1: Add canonical repository preview metadata

**Files:**
- Modify: `apps/mcp-server/src/github/github-app.ts`
- Modify: `apps/mcp-server/src/github/github-provider.ts`

**Interfaces:**
- Consumes: GitHub installation repository response containing `total_count` and a bounded repository array.
- Produces: `GitHubConnectionStatus` with optional `repositoryPreviewCount`, `repositoriesTruncated`, and `repositoryListingTool`.

- [x] **Step 1: Add the metadata fields to `GitHubConnectionStatus`.**
- [x] **Step 2: Derive preview count from the bounded repository array.**
- [x] **Step 3: Mark previews truncated only when preview count is below total count.**
- [x] **Step 4: Identify `repository.list` as the complete discovery tool.**
- [x] **Step 5: Produce metadata in `GitHubAppClient.getConnectionStatus()`.**
- [x] **Step 6: Keep `DatabaseBackedGitHubProvider` as a direct pass-through.**

### Task 2: Add focused regression tests

**Files:**
- Create: `apps/mcp-server/src/github/github-connection-status.test.ts`
- Create: `apps/mcp-server/src/github-connection-status.test.ts`

**Interfaces:**
- Consumes: `GitHubAppClient` and the registered `github.connection_status` MCP tool.
- Produces: regression coverage at both the canonical client and MCP serialization boundaries.

- [x] **Step 1: Test 45 total repositories with a 20-item preview.**
- [x] **Step 2: Test a complete preview that is not truncated.**
- [x] **Step 3: Assert status output does not expose the installation token.**
- [x] **Step 4: Call `github.connection_status` through linked in-memory MCP transports.**
- [x] **Step 5: Assert the MCP JSON response contains actionable preview metadata.**

### Task 3: Document complete repository discovery

**Files:**
- Create: `docs/github-repository-discovery.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: status metadata and the existing `repository.list` cursor contract.
- Produces: an actionable 20 + 20 + 5 example for 45 repositories and discoverable documentation links.

- [x] **Step 1: Explain that `github.connection_status.repositories` is a preview.**
- [x] **Step 2: Document the new metadata fields.**
- [x] **Step 3: Show repeated `repository.list` calls until `nextCursor` is absent.**
- [x] **Step 4: State that `codem:execute`, `terminal.exec`, and `gh` are unnecessary.**
- [x] **Step 5: Link the guide from the README GitHub section and documentation index.**

### Task 4: Verify and update the pull request

**Files:**
- Review: all branch changes.

- [x] **Step 1: Confirm the regression test fails before the canonical client fix.**
- [x] **Step 2: Remove provider-local metadata code and tests.**
- [x] **Step 3: Run formatting, lint, typecheck, tests, and Docker build through CI.**
- [x] **Step 4: Compare the final branch against `main` and review for scope creep.**
- [x] **Step 5: Update pull request #7 with final verification evidence.**
