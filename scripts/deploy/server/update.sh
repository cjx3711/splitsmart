#!/bin/bash
set -euo pipefail

# Runs ON THE SERVER. Uploaded and invoked by scripts/deploy/deploy.sh — not
# meant to be run by hand except to retry a failed deploy or to apply an
# edited env file (see README.md: docker start does not pick up env changes).
#
# Usage: update.sh <data_dir> <env_file> <port> <image_name> <container_name>
#
# Every check that can abort runs BEFORE the existing container is touched,
# so a failure here never leaves the server without a running instance.

DATA_DIR="${1:?data dir required}"
ENV_FILE="${2:?env file required}"
PORT="${3:?port required}"
IMAGE_NAME="${4:?image name required}"
CONTAINER_NAME="${5:?container name required}"

DB_NAME="splitsmart.db"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_DIR="${SCRIPT_DIR}/../database_backups"
TAR="${SCRIPT_DIR}/../${IMAGE_NAME}.tar"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")

mkdir -p "$BACKUP_DIR"

if [ ! -f "$ENV_FILE" ]; then
  echo "Error: env file ${ENV_FILE} not found. deploy.sh should have installed it."
  exit 1
fi

ENV_FILE_MODE=$(stat -c "%a" "$ENV_FILE")
if [ "$ENV_FILE_MODE" != "600" ]; then
  echo "Error: ${ENV_FILE} has mode ${ENV_FILE_MODE}, expected 600."
  echo "Fix with: chown root:root ${ENV_FILE} && chmod 600 ${ENV_FILE}"
  exit 1
fi

if [ ! -f "$TAR" ]; then
  echo "Error: ${TAR} not found. deploy.sh should have uploaded it."
  exit 1
fi

mkdir -p "$DATA_DIR"
mkdir -p "${DATA_DIR}/backups"

# The database is created by the app's own migration on first boot, so a
# fresh deploy has nothing to back up yet — that's expected, not an error.
if [ -f "${DATA_DIR}/${DB_NAME}" ]; then
  if ! command -v sqlite3 >/dev/null 2>&1; then
    echo "Error: sqlite3 is required to take a consistent backup of a WAL database."
    echo "Install it with: apt-get install -y sqlite3"
    echo "Refusing to update without a trustworthy pre-update backup."
    exit 1
  fi

  DEST="${BACKUP_DIR}/${DB_NAME}_${TIMESTAMP}"
  echo "Backing up existing database before update..."
  # .backup takes a consistent snapshot of a WAL database whether or not the
  # container is running; a plain cp of the main file can silently miss
  # anything still sitting in the -wal sidecar.
  sqlite3 "${DATA_DIR}/${DB_NAME}" ".backup '${DEST}'"

  # Collapse the snapshot to a single self-contained file so it can be moved
  # around safely (a WAL backup is really three files, and copying it
  # incompletely is exactly the failure mode this step exists to avoid).
  sqlite3 "$DEST" "PRAGMA journal_mode=DELETE;" > /dev/null
  rm -f "${DEST}-wal" "${DEST}-shm"

  if [ "$(sqlite3 "$DEST" "PRAGMA integrity_check")" != "ok" ]; then
    echo "Error: integrity check FAILED for ${DEST}. Aborting update."
    exit 1
  fi
  echo "Database backed up to ${DEST}"
else
  echo "No existing database at ${DATA_DIR}/${DB_NAME} — first deploy, skipping backup."
fi

if docker ps --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
  echo "Stopping and removing running container..."
  docker stop "$CONTAINER_NAME"
  docker rm "$CONTAINER_NAME"
elif docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
  echo "Removing stopped container..."
  docker rm "$CONTAINER_NAME"
fi

echo "Loading new image..."
docker load -i "$TAR"

echo "Starting container with bind mount ${DATA_DIR}:/data on port ${PORT}..."
docker run --name "$CONTAINER_NAME" \
  -d \
  --restart unless-stopped \
  -p "${PORT}:5545" \
  -v "${DATA_DIR}:/data" \
  --env-file "$ENV_FILE" \
  "$IMAGE_NAME"

echo "Update complete."
