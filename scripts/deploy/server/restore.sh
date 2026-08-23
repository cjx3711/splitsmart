#!/bin/bash
set -euo pipefail

# Runs ON THE SERVER. Restores a single-file sqlite snapshot (as produced by
# backup.sh or the automatic pre-update backup) over the live database.
#
# Usage: restore.sh <data_dir> <container_name> <path/to/backup/file>

DATA_DIR="${1:?data dir required}"
CONTAINER_NAME="${2:?container name required}"
SOURCE="${3:?path to backup file required}"
DB_NAME="splitsmart.db"

if [ ! -f "$SOURCE" ]; then
  echo "Error: backup file ${SOURCE} not found."
  exit 1
fi

# If the source itself has a -wal sidecar (e.g. you pointed this at a raw
# .backup output rather than one already collapsed by backup.sh), checkpoint
# it into the source first so the restore doesn't drop its most recent
# transactions.
if [ -f "${SOURCE}-wal" ]; then
  echo "Source has a -wal sidecar; checkpointing into it first..."
  sqlite3 "$SOURCE" "PRAGMA wal_checkpoint(TRUNCATE);"
fi

WAS_RUNNING=false
if docker ps --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
  WAS_RUNNING=true
  echo "Stopping ${CONTAINER_NAME}..."
  docker stop "$CONTAINER_NAME"
fi

echo "Restoring ${SOURCE} to ${DATA_DIR}/${DB_NAME}..."
cp "$SOURCE" "${DATA_DIR}/${DB_NAME}"

# Sidecars belong to the database just overwritten, not the one just
# restored — leaving them would let stale WAL frames apply on next boot.
rm -f "${DATA_DIR}/${DB_NAME}-wal" "${DATA_DIR}/${DB_NAME}-shm"

if [ "$WAS_RUNNING" = true ]; then
  echo "Starting ${CONTAINER_NAME}..."
  docker start "$CONTAINER_NAME"
fi

echo "Restore complete."
