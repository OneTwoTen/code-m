# GitHub Repository Preview Metadata Design

## Problem

The GitHub App installation can access 45 repositories. `repository.list` already supports bounded cursor pagination, but `github.connection_status` returns only a 20-repository preview while also reporting the full repository count.

Because the status response does not explicitly label the preview as truncated or identify the read-only listing tool, a coding agent can incorrectly conclude that CodeM cannot access the remaining repositories and attempt a terminal-based workaround requiring `codem:execute`.

## Scope

Keep `github.connection_status` bounded and add backward-compatible metadata that makes partial repository previews explicit:

```ts
{
  repositoryPreviewCount: number;
  repositoriesTruncated: boolean;
  repositoryListingTool: "repository.list";
}
```

Complete discovery continues to use the existing `repository.list` cursor contract and requires only `codem:read`.

## Design

- Annotate successful status responses when `repositoryCount` is available.
- Derive `repositoryPreviewCount` from the returned preview array.
- Set `repositoriesTruncated` when the preview count is smaller than the total count.
- Return `repositoryListingTool: "repository.list"` so agents have a structured next action.
- Leave unconfigured and failed status responses unchanged when repository count data is unavailable.
- Do not add another GitHub API request to a connection-status check.
- Preserve all existing status fields and the existing bounded preview.
- Keep installation tokens, clone credentials, and raw upstream error bodies server-side.

## Testing

Add focused tests for:

- 45 total repositories with a 20-item preview
- a complete preview that is not truncated
- an unreachable status without invented repository metadata

Document the 20 + 20 + 5 `repository.list` flow and state explicitly that repository discovery does not require `codem:execute`.

## Non-goals

- Returning an unbounded repository list from `github.connection_status`
- Changing the existing opaque cursor format
- Enabling terminal execution
- Changing workspace checkout behavior
- Refactoring unrelated GitHub integration code
