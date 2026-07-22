# GitHub repository discovery

CodeM exposes two read-only GitHub discovery tools with different purposes.

## Connection status

`github.connection_status` checks whether the configured GitHub App installation is authenticated and reachable. Its `repositories` field is a bounded preview, not a complete repository listing.

When repository count data is available, the response includes:

```ts
{
  repositoryCount: number;
  repositories: Array<RepositoryPreview>;
  repositoryPreviewCount: number;
  repositoriesTruncated: boolean;
  repositoryListingTool: "repository.list";
}
```

For an installation with 45 repositories, the status response can contain:

```json
{
  "repositoryCount": 45,
  "repositoryPreviewCount": 20,
  "repositoriesTruncated": true,
  "repositoryListingTool": "repository.list"
}
```

A truncated status preview does not mean CodeM lacks access to the remaining repositories.

## Complete repository listing

Use `repository.list` to retrieve every repository authorized for the installation. This tool requires only `codem:read`; it does not require `codem:execute`, `terminal.exec`, or the GitHub CLI.

Start with a bounded page:

```ts
repository.list({ limit: 20 })
```

When the response contains `nextCursor`, pass that opaque value back as `cursor`:

```ts
repository.list({ cursor: previous.nextCursor })
```

Do not decode, edit, or construct cursors in the client. Continue until `nextCursor` is absent.

For 45 repositories with a page size of 20, the flow is:

```text
page 1: 20 repositories + nextCursor
page 2: 20 repositories + nextCursor
page 3:  5 repositories + no nextCursor
```

Clients may request up to 100 repositories per page. They must still follow `nextCursor` whenever it is returned.

## Security

Repository discovery returns repository metadata only. Installation tokens and credential-bearing clone URLs remain server-side and are never returned by these tools.
