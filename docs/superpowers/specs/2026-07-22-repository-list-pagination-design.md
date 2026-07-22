# Repository List Pagination Design

## Problem

The GitHub App installation can access 45 repositories, but CodeM currently exposes only the first 20 through repository discovery. Clients cannot retrieve the remaining repositories without attempting terminal-based workarounds that require `codem:execute`.

## Scope

Fix `repository.list` so clients can retrieve all authorized repositories page by page using `{ cursor?: string; limit?: number }`, receiving `{ repositories, nextCursor? }`.

Repository discovery remains read-only and requires only `codem:read`.

## Design

- Keep the existing repository-listing tool and GitHub App client boundary.
- Validate a bounded `limit` using existing schema conventions.
- Treat client cursors as opaque values.
- Translate the cursor into internal GitHub pagination state.
- Derive `nextCursor` from GitHub pagination metadata rather than repository count heuristics.
- Omit `nextCursor` on the final page.
- Preserve stable repository ordering and existing metadata fields.
- Reject malformed or tampered cursors with a safe application error.
- Never place installation tokens, authenticated URLs, or raw upstream error bodies in cursors, logs, or MCP responses.

## Testing

Add tests covering a 45-repository installation retrieved in pages of 20, 20, and 5; final-page behavior; uniqueness and ordering; invalid cursors; scope enforcement; and credential redaction.

## Non-goals

- Enabling terminal execution.
- Fetching all repositories into one unbounded MCP response.
- Changing workspace checkout behavior.
- Refactoring unrelated GitHub integration code.
