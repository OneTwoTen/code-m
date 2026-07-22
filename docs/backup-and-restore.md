# Backup and restore

CodeM stores SQLite state at `/data/codem.sqlite` and persistent repository checkouts under `/data/workspaces`. SQLite includes users, sessions, OAuth clients and grants, token records, GitHub setup state, encrypted GitHub configuration, workspace lifecycle metadata, and migration history. Checkouts may contain uncommitted user changes that do not exist on GitHub.

## What must be protected

Back up these items together:

1. the complete persistent `/data` volume, including `codem.sqlite` and `workspaces/`
2. `CODEM_SECRET_KEY`
3. deployment configuration and the image version
4. external GitHub App or OIDC configuration when it is not stored in the database

`CODEM_SECRET_KEY` is required to decrypt encrypted settings after restore. Do not store it only inside the same volume as the database.

## Recommended backup: stop and snapshot

The simplest reliable method is a cold backup:

1. Stop the single CodeM replica.
2. Confirm no CodeM process is writing to `/data`.
3. Snapshot the volume or copy the complete `/data` directory.
4. Record the CodeM image tag or commit used by the backup.
5. Restart CodeM and confirm `/health` returns `200`.

Example for a bind-mounted directory:

```bash
docker stop codem

tar -C /srv/codem-data \
  -czf "codem-data-$(date -u +%Y%m%dT%H%M%SZ).tar.gz" \
  .

docker start codem
```

Stopping the application avoids copying an inconsistent mix of the main database and WAL files.

## Live backup options

A raw copy while CodeM is running must include `codem.sqlite`, `codem.sqlite-wal`, and `codem.sqlite-shm` from the same point in time. Ordinary file copies cannot guarantee that consistency.

Use one of these platform-aware methods instead:

- a storage snapshot documented as crash-consistent for all files in the volume
- SQLite's online backup API or `.backup` command from a maintenance environment with access to the volume

Example when a compatible `sqlite3` CLI is available outside the CodeM image:

```bash
sqlite3 /srv/codem-data/codem.sqlite \
  ".backup '/srv/backups/codem.sqlite.backup'"
```

The CodeM container does not promise to include the `sqlite3` CLI, so do not build an operational dependency on running this command inside the application container.

## Restore into an empty volume

1. Stop CodeM.
2. Preserve the damaged or current volume separately for investigation.
3. Create an empty replacement `/data` volume.
4. Restore the backup contents into that volume.
5. Restore the matching `CODEM_SECRET_KEY` and deployment configuration.
6. Ensure the container's unprivileged `bun` user can read and write the restored files.
7. Start the same CodeM image version used for the backup.
8. Confirm `/health` returns `200`.
9. Test administrator login, OAuth authorization, and one read-only MCP tool.
10. Upgrade to a newer image only after the restored version is confirmed healthy.

Example:

```bash
docker stop codem
rm -rf /srv/codem-data-restored
mkdir -p /srv/codem-data-restored
tar -C /srv/codem-data-restored -xzf codem-data-20260721T000000Z.tar.gz
# Adjust ownership to the UID/GID used by the bun user in your deployment.
docker start codem
```

Do not merge a restored database with an existing database directory. Restore into an empty volume.

## Validate a backup

A backup is not complete until it has been restored in a non-production environment. At minimum, verify:

- CodeM starts without migration errors
- `/health` reports `status: ok`
- the administrator can log in
- registered OAuth clients and grants are present
- GitHub configuration decrypts and the connection status can be checked
- a fresh authorization-code flow succeeds
- a restored ready workspace can read a known file by `workspaceId`
- expected uncommitted workspace changes are still present

Never validate by exposing a restored production database on a public test URL. Use an isolated host and rotate any credentials that could contact production services.

## Retention and rotation

Keep multiple generations so a silently corrupted or incorrectly migrated database does not replace the only good backup. A practical baseline is:

- daily backups for seven days
- weekly backups for four weeks
- one pre-upgrade backup for every deployed release

Encrypt backup archives at rest and restrict access to the same operators who can access CodeM's application secret.

## Disaster-recovery notes

- Losing only `CODEM_SETUP_TOKEN` does not make an initialized database unusable; it controls bootstrap access.
- Losing `CODEM_SECRET_KEY` can make encrypted settings unrecoverable even when the SQLite file is intact.
- OAuth access and refresh tokens stored in a restored backup may still be valid according to their timestamps. Treat backup access as credential access.
- Repository workspaces may contain private source code and uncommitted changes; protect backup archives as source-code and credential-bearing data.
- After suspected backup exposure, rotate `CODEM_SECRET_KEY` through a planned migration, rotate GitHub/OIDC credentials, revoke OAuth sessions/tokens, and replace the setup token.
