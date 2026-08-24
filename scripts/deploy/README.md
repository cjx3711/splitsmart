# Deploying SplitSmart

Single-container deploy: one Docker image serving the API and the built
frontend on port 5545, with SQLite persisted on a host bind mount so the
database survives every redeploy. This mirrors the pattern used for the
author's other self-hosted apps — a plain `docker run` on a single box, no
orchestrator, no managed database.

## One-time setup

1. **A server with Docker and SSH key access.** `deploy.sh` runs `ssh`,
   `scp` and `rsync` against it non-interactively, so make sure
   `ssh your-host` works without a password prompt first.

2. **`.env.deploy`** — where to deploy. Copy the template and fill it in:

   ```bash
   cp .env.deploy.example .env.deploy
   ```

   This holds the SSH target, the remote directory for the image/scripts, the
   host directory bind-mounted into the container, the path to the secrets
   file on the server, and the port to publish. See the comments in the file
   for what each one means. Never commit this file — it's already
   gitignored.

3. **`.env.prod`** — the app's own runtime secrets. Copy the template:

   ```bash
   cp .env.prod.example .env.prod
   ```

   At minimum set `SESSION_SECRET` (generate with the command in the
   comment) and `APP_ORIGIN` (your public URL, e.g.
   `https://splitsmart.example.com`). Everything else is optional — see the
   comments for what each variable does. `deploy.sh` will refuse to deploy
   if either required value is missing, if `SESSION_SECRET` is too short, if
   both mail providers are half-configured, or if the file sets one of the
   variables the deploy scripts manage themselves (`NODE_ENV`, `PORT`,
   `DATABASE_PATH`).

4. **DNS + TLS**, outside the deploy scripts entirely. Point your domain at
   the server, then set up a reverse proxy in front of port 5545 (or
   whatever `DEPLOY_PORT` you chose) — see `nginx.conf.example` for a
   starting point with Let's Encrypt via certbot. This only needs doing
   once; redeploys never touch it.

## Deploying

```bash
scripts/deploy/deploy.sh
```

This builds the image for `linux/amd64` (so it works on a typical cloud VM
even from an Apple Silicon laptop), saves it to a tar, ships the tar plus the
server-side scripts to the server, installs `.env.prod` there as a
`chmod 600` secrets file, and runs the server-side update.

Every run of `update.sh` on the server takes a verified, WAL-safe snapshot of
the existing database into `<DEPLOY_DIR>/database_backups/` **before**
touching the container — and every check that could abort the deploy runs
before the old container is removed, so a bad deploy never leaves you
without a running instance. On the very first deploy there's nothing to back
up yet; that's expected, not an error.

## Optional: telemetry on your own deploy

SplitSmart ships with no telemetry - `web/public/telemetry.js` is a committed
no-op stub, loaded by every HTML shell (`index.html`, `app.html`,
`guest.html`) via `<script defer src="/telemetry.js">`. Nothing here is
open-sourced.

If you want telemetry on your own instance, drop a `.telemetry.js` file at
the repo root (gitignored, never committed). When present, `deploy.sh`
copies its contents over the stub for that build only, then restores the
committed stub afterward so `git status` stays clean. Nothing else needs
touching.

## Updating secrets

Edit `.env.prod` locally and run `deploy.sh` again — it re-validates and
re-installs the file, then recreates the container so the new values take
effect. (Docker only reads `--env-file` at `docker run`, not `docker start`,
which is why a recreate is required rather than just restarting.)

## Database backups and restores

On the server, from `<DEPLOY_DIR>/server/`:

```bash
# Snapshot on demand (same thing update.sh does automatically pre-deploy)
./backup.sh <DEPLOY_DATA_DIR>

# Restore a snapshot over the live database
./restore.sh <DEPLOY_DATA_DIR> <container_name> path/to/backup/file
```

The database runs in **WAL mode**. That means `cp` or `rsync` of the main
`.db` file alone can silently miss committed transactions still sitting in
its `-wal` sidecar. Both scripts here use `sqlite3 <db> ".backup '<dest>'"`
instead, which takes a consistent snapshot whether or not the container is
running, then collapse the result to a single self-contained file (no
sidecars) so it's safe to move around.

Daily off-box copies are a separate in-app feature: set `BACKUP_S3_BUCKET`
plus access key/secret in `.env.prod` (see `.env.prod.example`). The server
then VACUUM INTOs `/data/backups`, gzip-streams the snapshot to S3-compatible
storage (Tigris by default), keeps a week of dailies plus one object per ISO
week, and shows the run log at `/app/admin/backups`. That path never replaces
the pre-deploy snapshots above — those are still the thing you restore with
`restore.sh` after a bad deploy.

If you ever need to inspect this by hand: `.backup` output inherits WAL
mode and initially comes with `-wal`/`-shm` files of its own — copying such
a snapshot without all three pieces reproduces the exact problem the scripts
exist to avoid. Rule of thumb: never touch the live `.db` file directly with
plain file tools; always go through `sqlite3 .backup` or these scripts.

## Layout on the server

```
<DEPLOY_DIR>/                    e.g. /root/projects/splitsmart
  splitsmart-app.tar             uploaded by deploy.sh, replaced each deploy
  server/
    update.sh                    run automatically by deploy.sh
    backup.sh                    run by hand
    restore.sh                   run by hand
  database_backups/              timestamped pre-deploy snapshots

<DEPLOY_DATA_DIR>/                e.g. /data/splitsmart — NOT shared with any
  splitsmart.db                   other app's data directory
  splitsmart.db-wal
  splitsmart.db-shm
  backups/                        VACUUM INTO temp files for daily S3 backups
                                  (orphans older than 6h are swept)

<DEPLOY_ENV_FILE>                 e.g. /etc/splitsmart/splitsmart.env
                                   root:root, chmod 600 — installed by deploy.sh,
                                   deliberately outside both directories above so
                                   moving either around never carries a secret
                                   with it
```
