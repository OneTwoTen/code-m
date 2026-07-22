# Repository List Pagination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `repository.list` expose reliable cursor-based pagination so clients can retrieve every repository authorized for the GitHub App installation without `codem:execute`.

**Architecture:** Preserve the existing GitHub repository client and MCP tool boundary, but carry pagination state through a validated opaque cursor and return `nextCursor` from upstream pagination metadata. Add focused tests for multi-page retrieval, final-page behavior, invalid input, and scope requirements before changing production code.

**Tech Stack:** TypeScript, Bun, MCP SDK, existing GitHub App client, existing test framework.

## Global Constraints

- Repository discovery must require only `codem:read`.
- Repository discovery must not execute shell commands or require `codem:execute`.
- Cursors must be opaque to MCP clients and must not contain credentials.
- Upstream GitHub errors must be sanitized.
- Existing repository metadata fields and ordering must remain compatible.

---

### Task 1: Characterize the current repository listing path

**Files:**
- Inspect: repository-listing tool handler, GitHub client, schemas, and current tests discovered in the repository.
- Modify: none.

**Interfaces:**
- Consumes: current `repository.list` input/output schema and GitHub installation repository response.
- Produces: exact file map and current behavior used by Tasks 2-4.

- [ ] **Step 1: Locate the tool handler, GitHub repository client, schema definitions, and tests.**
- [ ] **Step 2: Record the current page-size default, maximum, scope guard, and upstream pagination metadata.**
- [ ] **Step 3: Identify whether truncation occurs in the GitHub client, tool handler, or schema serialization.**

### Task 2: Add failing pagination tests

**Files:**
- Modify: existing repository-listing test file(s) discovered in Task 1.

**Interfaces:**
- Consumes: existing test helpers and `repository.list` invocation API.
- Produces: failing tests that specify `cursor`, `limit`, and `nextCursor` behavior.

- [ ] **Step 1: Add a test where 45 repositories are exposed as pages of 20, 20, and 5.**
- [ ] **Step 2: Assert page one and page two include `nextCursor`, while page three omits it.**
- [ ] **Step 3: Assert concatenating all pages yields 45 unique repositories in stable order.**
- [ ] **Step 4: Add a test that malformed cursors fail with the repository tool's safe validation error.**
- [ ] **Step 5: Run the focused test command and confirm the new tests fail because pagination is missing or truncated.**

### Task 3: Implement minimal cursor pagination

**Files:**
- Modify: repository-listing schema/tool handler and GitHub client files discovered in Task 1.

**Interfaces:**
- Consumes: `{ cursor?: string; limit?: number }`.
- Produces: `{ repositories: RepositorySummary[]; nextCursor?: string }`.

- [ ] **Step 1: Validate `limit` using the existing schema conventions and retain the established safe default and maximum.**
- [ ] **Step 2: Decode the opaque cursor into internal pagination state without accepting credential-bearing URLs.**
- [ ] **Step 3: Pass the requested page state and limit to the GitHub installation repository endpoint.**
- [ ] **Step 4: Derive the next page only from upstream pagination metadata and encode it as an opaque cursor.**
- [ ] **Step 5: Return repository summaries plus `nextCursor` only when another page exists.**
- [ ] **Step 6: Keep the tool guarded by `codem:read`; do not call terminal execution paths.**
- [ ] **Step 7: Run the focused tests and confirm they pass.**

### Task 4: Regression, security, and documentation checks

**Files:**
- Modify: tool catalog or README pagination example if the current docs do not already describe cursor iteration.
- Modify: security/error tests if needed.

**Interfaces:**
- Consumes: completed pagination implementation.
- Produces: documented and regression-tested behavior.

- [ ] **Step 1: Add or update a tool documentation example showing iteration until `nextCursor` is absent.**
- [ ] **Step 2: Assert cursors and errors never expose installation tokens or credential-bearing GitHub URLs.**
- [ ] **Step 3: Run formatting, type checking, focused tests, and the complete test suite using repository scripts.**
- [ ] **Step 4: Compare the branch against `main` and review every changed file for scope creep.**
- [ ] **Step 5: Open a pull request that closes the pagination issue and includes test evidence.**
