# CodeM

CodeM is a self-hosted MCP server for coding agents. It supports local stdio and authenticated Streamable HTTP, keeps application state in SQLite by default, and exposes a small set of bounded coding tools.

## Current capabilities

| Capability | Local stdio | Remote HTTP |
|---|---:|---:|
| `system.info` | Yes | `codem:read` |
| `repository.list` | With GitHub configuration | `codem:read` |
| `workspace.open_repository` | No | `codem:workspace` |
| `workspace.read_file` | Yes | `codem:read` plus `workspaceId` |
| `github.connection_status` | Yes | `codem:read` |
| `terminal.exec` | Yes | Disabled by default |

`terminal.exec` receives an executable and argument array rather than a shell command string. It enforces a workspace-relative working directory, timeout, stdin/output limits, a reduced environment, and process-tree termination.

Remote terminal execution is intentionally unavailable through the embedded OAuth flow. CodeM is not yet a hardened multi-tenant sandbox.

## Requirements

- Bun 1.3.3 for local development
- Docker for the recommended self-hosted HTTP deployment
- HTTPS for public HTTP deployments

## Verify a checkout

```bash
bun install --frozen-lockfile
bun run check
```

The check runs Biome formatting and linting, TypeScript type checking, unit/integration tests, and MCP end-to-end tests. CI also builds the Docker image.

## Local stdio mode

```bash
CODEM_WORKSPACE_ROOT=/absolute/path/to/project bun run dev
```

Example MCP client configuration:

```json
{
  "mcpServers": {
    "code-m": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/code-m/apps/mcp-server/src/main.ts"],
      "env": {
        "CODEM_WORKSPACE_ROOT": "/absolute/path/to/project"
      }
    }
  }
}
```

Diagnostics are written to stderr so stdout remains valid MCP stdio traffic.

## One-container HTTP deployment

Build the image:

```bash
docker build -t codem-mcp .
```

Create persistent directories and strong secrets:

```bash
mkdir -p ./codem-data
openssl rand -base64 48   # CODEM_SECRET_KEY
openssl rand -base64 32   # CODEM_SETUP_TOKEN
```

Run CodeM behind an HTTPS reverse proxy:

```bash
docker run -d \
  --name codem \
  --restart unless-stopped \
  -p 3000:3000 \
  -e CODEM_TRANSPORT=http \
  -e CODEM_PUBLIC_URL=https://codem.example.com \
  -e CODEM_SECRET_KEY='replace-with-the-first-generated-secret' \
  -e CODEM_SETUP_TOKEN='replace-with-the-second-generated-token' \
  -v "$PWD/codem-data:/data" \
  codem-mcp
```

The default database is `/data/codem.sqlite`, and Git-backed checkouts live under `/data/workspaces`. Keep the entire `/data` directory on one persistent volume. `CODEM_PUBLIC_URL` must be the public origin without a path, query, or fragment.

After the container is reachable:

1. Open `https://codem.example.com/setup?setup_token=...` once to create the administrator account.
2. Remove or rotate `CODEM_SETUP_TOKEN` after bootstrap.
3. Complete GitHub App setup from `/setup` when GitHub access is needed.
4. Configure the coding client with `https://codem.example.com/mcp`.
5. Approve `codem:read` and `codem:workspace` during OAuth authorization.

Avoid sharing or logging the setup URL because its query contains the bootstrap token.

Health check:

```bash
curl https://codem.example.com/health
```

See [Deployment](docs/deployment.md) for Coolify, external OIDC, migration, and scaling guidance.

## Authentication

### Embedded OAuth

Embedded OAuth is the default. It provides:

- dynamic client registration with HTTPS or loopback redirect validation
- administrator login sessions
- explicit consent with CSRF-bound, single-use authorization requests
- persisted grants
- authorization-code flow with PKCE
- single-use authorization codes and rotating refresh tokens

Embedded OAuth grants `codem:read` and `codem:workspace`. It does not grant `codem:execute` in this release.

### External OIDC

Advanced deployments can use token introspection by setting `CODEM_AUTH_PROVIDER=external-oidc` and the issuer, introspection endpoint, client ID, and client secret. Introspected tokens must include an `aud` or `resource` value matching the MCP URL.

## GitHub App

The preferred self-hosted path is the `/setup` wizard. Environment-based GitHub App configuration remains available for automated deployments:

```env
GITHUB_APP_ID=12345
GITHUB_APP_INSTALLATION_ID=67890
GITHUB_APP_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
```

GitHub installation tokens and private keys stay server-side and are never returned through MCP. Use `repository.list`, then `workspace.open_repository`, and pass the returned `workspaceId` to workspace tools. Clean workspaces are updated on reopen; dirty workspaces are preserved and rejected with `WORKSPACE_DIRTY`.

## Important environment variables

| Variable | Default | Purpose |
|---|---|---|
| `CODEM_TRANSPORT` | `stdio` | `stdio` or `http` |
| `CODEM_WORKSPACE_ROOT` | Current directory | Local stdio workspace root |
| `CODEM_PUBLIC_URL` | — | Required public origin in HTTP mode |
| `CODEM_SECRET_KEY` | — | Required application encryption secret in HTTP mode |
| `CODEM_SETUP_TOKEN` | — | Bootstrap guard for `/setup` |
| `CODEM_DATA_DIR` | `/data` | Persistent application state directory |
| `CODEM_WORKSPACES_DIR` | `/data/workspaces` | Persistent Git repository checkouts |
| `CODEM_DATABASE_URL` | `file:/data/codem.sqlite` | SQLite database URL |
| `CODEM_OUTBOUND_HTTP_TIMEOUT_MS` | `10000` | OAuth/GitHub request deadline |
| `CODEM_ALLOW_REMOTE_TERMINAL` | `false` | Additional remote-terminal policy switch |

Copy `.env.example` for the complete list.

## Storage, backup, and scaling

SQLite is the implemented production adapter. Run one writable CodeM replica against a persistent `/data` volume containing both SQLite and repository workspaces. Workspace checkouts may contain uncommitted user changes and must be backed up and access-controlled with the database. Do not mount the same database into multiple application replicas.

Read [Backup and restore](docs/backup-and-restore.md) before upgrades. A PostgreSQL-compatible application boundary exists for future work, but a production PostgreSQL adapter is not shipped in this release.

## Repository layout

```text
apps/mcp-server/       HTTP/stdio composition root, auth, GitHub, SQLite
packages/core/         portable contracts and workspace policy
packages/adapters/     Bun process adapter
tests/e2e/             stdio and HTTP boundary tests
docs/                  architecture, deployment, security, operations
```

## Documentation

- [Architecture](docs/architecture.md)
- [Deployment](docs/deployment.md)
- [Backup and restore](docs/backup-and-restore.md)
- [Security model](docs/security-model.md)
- [Tool catalog](docs/tool-catalog.md)
- [Terminal executor](docs/terminal-executor.md)
- [Roadmap](docs/roadmap.md)

## Current boundaries

CodeM is suitable for a single-operator, self-hosted deployment. It does not yet provide a hardened multi-tenant sandbox, rate limiting, distributed jobs, production PostgreSQL support, or horizontally scalable shared state.
