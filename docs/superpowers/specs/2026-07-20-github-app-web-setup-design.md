# GitHub App web setup design

## Goal

Add a browser-based GitHub App provisioning flow to CodeM so a self-hosted administrator can connect GitHub without manually copying an App ID, installation ID, and private key into environment variables.

The existing environment-driven GitHub App configuration remains supported as an advanced fallback.

## User flow

1. The administrator creates the first CodeM account at `/setup` and signs in.
2. The setup page shows a GitHub integration section with a `Connect GitHub` action.
3. CodeM starts a GitHub App Manifest flow and redirects the administrator to GitHub.
4. GitHub asks the administrator to create the App and returns a short-lived manifest code to CodeM.
5. CodeM exchanges the manifest code for GitHub App credentials and stores the sensitive values encrypted at rest.
6. CodeM redirects the administrator to install the new App.
7. The administrator chooses a user or organization account and selects repository access.
8. GitHub redirects back with the installation ID.
9. CodeM validates the installation by creating an App JWT, exchanging it for an installation token, and listing accessible repositories.
10. The setup page shows connection status, installation metadata, and accessible repositories without exposing credentials.

## Architecture

### GitHub setup controller

Add a focused HTTP component responsible for:

- rendering the GitHub setup status page;
- requiring a valid administrator browser session;
- creating and validating short-lived setup state values;
- starting the manifest flow;
- exchanging the GitHub manifest code;
- handling the installation callback;
- testing and disconnecting the integration.

The controller is mounted by the existing HTTP handler but remains separate from the embedded OAuth implementation.

### Persistent configuration

Store one active GitHub App configuration and one active installation in SQLite.

Sensitive fields:

- private key;
- client secret;
- webhook secret.

These fields are encrypted with an authenticated encryption key derived from `CODEM_SECRET_KEY`. Plaintext secrets must never be logged, returned through MCP, or rendered in HTML.

Non-sensitive fields such as App ID, installation ID, account login, account type, and repository selection may be stored directly.

Environment variables continue to take precedence when all required GitHub App values are present. Otherwise CodeM loads the database-backed configuration.

### Runtime provider

Replace startup-only GitHub client construction with a provider that resolves the current configuration when `github.connection_status` or future GitHub tools are called.

The provider:

- uses environment configuration when complete;
- otherwise loads and decrypts the database-backed configuration;
- creates or reuses a `GitHubAppClient` for the resolved configuration;
- invalidates cached clients when the web setup changes or disconnects the integration.

Installation access tokens remain memory-only and are refreshed by the existing `GitHubAppClient`.

## Routes

- `GET /setup/github` — show current integration status.
- `POST /setup/github/manifest` — create setup state and redirect to GitHub's manifest creation page.
- `GET /setup/github/manifest/callback` — validate state, exchange the manifest code, store encrypted App credentials, and redirect to installation.
- `GET /setup/github/install/callback` — validate state and installation ID, verify repository access, then show success.
- `POST /setup/github/test` — perform a live connection test.
- `POST /setup/github/disconnect` — delete database-backed GitHub credentials and installation metadata.

All mutation routes require an authenticated administrator session and CSRF protection.

## Security

- Manifest and installation callbacks use random, single-use, expiring state values stored as hashes.
- Setup POST routes use CSRF tokens bound to the administrator session.
- Sensitive GitHub credentials are encrypted with authenticated encryption before SQLite persistence.
- The private key and installation token are never returned to the browser or MCP client.
- The callback accepts only expected GitHub parameters and rejects missing, expired, consumed, or mismatched state.
- Disconnect revokes local use immediately by deleting persisted credentials and invalidating in-memory clients. It does not uninstall the GitHub App remotely.
- HTML output must escape GitHub-provided account and repository names.

## Failure handling

The setup page presents actionable failures for:

- GitHub manifest exchange failure;
- missing or invalid callback state;
- invalid installation ID;
- App JWT signing failure;
- installation-token exchange failure;
- no accessible repositories;
- missing `CODEM_SECRET_KEY` in HTTP mode.

Failed callbacks do not overwrite a previously working configuration until the new credentials have been validated.

## Testing

Add tests for:

- encryption round-trip and tamper rejection;
- setup-state expiry, single use, and session binding;
- admin-session and CSRF enforcement;
- manifest payload and redirect generation;
- manifest callback exchange and encrypted persistence;
- installation callback validation;
- environment-over-database precedence;
- runtime provider cache invalidation;
- successful and failed connection-status checks;
- regression coverage for embedded OAuth and `/mcp` authentication.

## Out of scope

- Using GitHub OAuth login as CodeM user authentication.
- Supporting multiple GitHub Apps or installations at once.
- Webhook event processing.
- Remote uninstall of the GitHub App.
- Exposing GitHub installation tokens to MCP clients.
