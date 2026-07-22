# Deployment

## Recommended topology

The supported self-hosted topology is intentionally small:

```text
MCP client
    |
    | HTTPS
    v
reverse proxy / platform ingress
    |
    v
one CodeM container
    `-- /data
        |-- codem.sqlite
        `-- workspaces/
```

Use one writable CodeM replica and one persistent `/data` volume. The container listens on port 3000 and exposes `/health` and `/mcp`.

## Required configuration

```env
CODEM_TRANSPORT=http
CODEM_PUBLIC_URL=https://codem.example.com
CODEM_SECRET_KEY=<long random application secret>
CODEM_SETUP_TOKEN=<separate bootstrap token>
CODEM_DATA_DIR=/data
CODEM_WORKSPACES_DIR=/data/workspaces
```

`CODEM_PUBLIC_URL` is the public origin used for OAuth metadata, redirects, resource identifiers, and the MCP URL. It must:

- use HTTPS outside localhost
- contain no credentials, query, or fragment
- use the root path; base-path deployments such as `/codem` are rejected

The resulting MCP endpoint is `https://codem.example.com/mcp`.

## Docker

```bash
docker build -t codem-mcp .

docker run -d \
  --name codem \
  --restart unless-stopped \
  -p 3000:3000 \
  --env-file .env \
  -v codem-data:/data \
  codem-mcp
```

The image runs as the unprivileged `bun` user. Ensure bind-mounted paths are readable and, where mutation is intended, writable by that user.

## Coolify

Use these application settings:

| Setting | Value |
|---|---|
| Build pack | Dockerfile |
| Container port | `3000` |
| Health path | `/health` |
| Public domain | Root domain, for example `codem.example.com` |
| HTTPS | Enabled |
| Persistent storage | A volume mounted at `/data` |
| Repository workspaces | Stored inside the persistent `/data` volume |
| Replicas | `1` |

Set the required environment variables in Coolify. Do not put CodeM behind a path prefix. Forward the original `Host` header because CodeM validates it against the configured public URL.

## First-run bootstrap

1. Start the container with a strong `CODEM_SETUP_TOKEN`.
2. Open `/setup?setup_token=...` over HTTPS.
3. Create the initial administrator account.
4. Complete the GitHub App wizard when GitHub access is needed.
5. Remove or rotate the setup token and redeploy.

The query-string bootstrap route exists for browser setup. Treat that URL as a secret and avoid retaining it in chat, screenshots, analytics, proxy logs, or browser history.

## Database and migrations

The default database URL is:

```text
file:/data/codem.sqlite
```

CodeM enables SQLite WAL mode, foreign keys, and a busy timeout. Schema migrations run synchronously during application startup before the HTTP listener is considered ready. A failed migration prevents startup rather than serving with a partially upgraded schema.

Back up `/data` before deploying a build that contains migrations. See [Backup and restore](backup-and-restore.md).

## Authentication choices

### Embedded OAuth

Embedded OAuth is the default and the simplest deployment. It includes login, consent, PKCE authorization codes, persisted grants, and rotating refresh tokens.

Configure `codem:read codem:workspace` for embedded OAuth in this release. The HTTP boundary rejects embedded requests for `codem:execute`.

### External OIDC introspection

For an existing identity provider:

```env
CODEM_AUTH_PROVIDER=external-oidc
CODEM_AUTH_ISSUER=https://auth.example.com
CODEM_AUTH_INTROSPECTION_URL=https://auth.example.com/oauth2/introspect
CODEM_AUTH_CLIENT_ID=codem-resource-server
CODEM_AUTH_CLIENT_SECRET=<secret>
CODEM_AUTH_SCOPES=codem:read codem:workspace
```

Active tokens must contain an `aud` or `resource` claim matching the full MCP URL. CodeM bounds introspection requests using `CODEM_OUTBOUND_HTTP_TIMEOUT_MS`.

## GitHub App

The `/setup` wizard stores GitHub App configuration encrypted with `CODEM_SECRET_KEY`. Environment-driven configuration is available when infrastructure automation owns the GitHub App:

```env
GITHUB_APP_ID=12345
GITHUB_APP_INSTALLATION_ID=67890
GITHUB_APP_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
```

All GitHub API requests have the same bounded outbound deadline. Installation tokens and private keys remain server-side. Clone/fetch authentication uses an ephemeral askpass helper, while the persisted `origin` URL remains credential-free. Repository opens are serialized within one CodeM process; multi-replica workspace coordination is not supported.

## Remote terminal policy

`CODEM_ALLOW_REMOTE_TERMINAL=false` is the safe default. Even when switched on, embedded OAuth cannot currently grant `codem:execute`, so a production external authorization policy and an isolated executor are still required before remote terminal use is appropriate.

The local process adapter implements command/argument separation, workspace-bound `cwd`, byte limits, timeouts, process-group termination, and TERM-to-KILL escalation. These controls reduce accidental exposure but are not a multi-tenant sandbox.

## Scaling limits

SQLite-backed CodeM must run as one writable replica. Do not:

- mount one SQLite database into multiple application replicas
- place `/data` on an unsafe network filesystem
- assume OAuth/session state can be served from independent local volumes

The application-facing OAuth storage contract is separated from SQLite so a PostgreSQL adapter can be added later. This release does not ship or claim production PostgreSQL support.

## Upgrade checklist

1. Read release and migration notes.
2. Stop writes or stop the single CodeM replica.
3. Back up `/data` and deployment secrets.
4. Deploy the new image with the same persistent volume.
5. Confirm startup completes and `/health` returns `200`.
6. Test an OAuth login and a read-only MCP tool.
7. Retain the previous image and backup until verification is complete.
