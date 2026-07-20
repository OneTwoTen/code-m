# Remote MCP Authentication and GitHub App Design

## Goal

Extend CodeM from a local stdio proof of concept into a remote MCP resource server that ChatGPT can connect to, while keeping GitHub credentials server-side and scoped to a GitHub App installation.

## Architecture

CodeM has two independent trust boundaries:

1. ChatGPT authenticates to CodeM with an OAuth 2.1 access token.
2. CodeM authenticates to GitHub as a GitHub App installation.

The ChatGPT access token never becomes a GitHub credential. GitHub installation tokens never leave CodeM.

```text
ChatGPT
  -> HTTPS /mcp + Bearer CodeM access token
CodeM resource server
  -> token introspection at authorization server
  -> GitHub App JWT
  -> short-lived GitHub installation token
GitHub API / Git HTTPS
```

## Remote MCP transport

CodeM supports two runtime modes:

- `stdio`: local coding agents, no HTTP authentication.
- `http`: remote clients, Streamable HTTP at `/mcp`.

The HTTP server exposes:

- `POST /mcp`: MCP Streamable HTTP requests.
- `GET /.well-known/oauth-protected-resource`: RFC 9728 protected resource metadata.
- `GET /health`: non-sensitive liveness response.

The HTTP implementation uses Bun Web APIs and `WebStandardStreamableHTTPServerTransport` in stateless JSON-response mode. A fresh MCP server and transport are created per request.

## CodeM OAuth resource server

CodeM does not implement an authorization server. It delegates login, consent, PKCE, client registration, and token issuance to an external OAuth 2.1 authorization server.

Required configuration in HTTP mode:

- `CODEM_PUBLIC_URL`: canonical HTTPS base URL.
- `CODEM_AUTH_ISSUER`: authorization server issuer.
- `CODEM_AUTH_INTROSPECTION_URL`: RFC 7662 token introspection endpoint.
- `CODEM_AUTH_CLIENT_ID`: resource-server introspection client ID.
- `CODEM_AUTH_CLIENT_SECRET`: resource-server introspection client secret.
- `CODEM_AUTH_SCOPES`: supported scopes.

For every `/mcp` request CodeM:

1. Requires an `Authorization: Bearer` header.
2. Calls the configured introspection endpoint with HTTP Basic client authentication.
3. Requires `active=true`.
4. Requires the token audience or `resource` to match `CODEM_PUBLIC_URL` when the introspection response provides either claim.
5. Converts `scope`, `client_id`, `sub`, and `exp` into MCP `AuthInfo`.
6. Returns HTTP 401 with a `WWW-Authenticate` challenge containing `resource_metadata` when authentication fails.

Tokens and client secrets are never logged.

## Scopes

Initial scopes:

- `codem:read`: system information, workspace reads, Git metadata, GitHub connection status.
- `codem:execute`: terminal execution.
- `codem:write`: future file mutation and Git write tools.

The first remote release requires `codem:read` for all tools and additionally requires `codem:execute` for `terminal.exec`.

## GitHub App integration

GitHub App configuration:

- `GITHUB_APP_ID`
- `GITHUB_APP_PRIVATE_KEY`
- `GITHUB_APP_INSTALLATION_ID`
- `GITHUB_API_URL`, default `https://api.github.com`

The private key accepts PEM text with escaped newlines so it can be stored in an environment secret.

For each GitHub request CodeM:

1. Creates an RS256 GitHub App JWT valid for at most ten minutes.
2. Exchanges it at `/app/installations/{installation_id}/access_tokens`.
3. Caches the installation token only in memory until sixty seconds before expiry.
4. Uses the installation token to call GitHub.
5. Never returns the token or private key in tool output.

## GitHub connection tool

`github.connection_status` reports:

- whether GitHub App configuration is complete;
- whether an installation token can be issued;
- whether the GitHub API is reachable;
- installation ID;
- repository selection and permissions returned by token issuance;
- number and a bounded preview of accessible repositories.

The tool is read-only and idempotent. Authentication or network errors are normalized without including response headers, request credentials, or token-bearing URLs.

## Local repository tools

Git repository state remains separate from the GitHub API connection. Later tools such as `git.status`, `git.diff`, and `git.remote_status` operate on the selected workspace. `github.connection_status` only proves the server-side GitHub App installation is usable.

## Security boundaries

- HTTP auth is mandatory whenever `CODEM_TRANSPORT=http`.
- `CODEM_PUBLIC_URL` must be HTTPS outside explicit local development.
- Remote `terminal.exec` remains disabled by default until a dedicated sandbox executor is configured.
- GitHub App permissions should start with metadata read and contents read.
- Installation tokens remain in memory and expire after one hour.
- No tool returns access tokens, authorization headers, private keys, or introspection client secrets.
- Host and origin allowlists are enforced in HTTP mode.

## Testing

Tests cover:

- protected resource metadata shape;
- missing and invalid bearer tokens;
- successful token introspection;
- audience mismatch;
- GitHub App JWT claims and signature creation;
- installation token caching;
- GitHub connection status with mocked HTTP responses;
- remote MCP initialize and tool listing over HTTP;
- existing stdio behavior.

CI runs Biome, TypeScript, Bun tests, and Docker build.