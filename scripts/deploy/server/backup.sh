#!/bin/bash
set -euo pipefail

# Runs ON THE SERVER. On-demand snapshot of the live database — the same
# backup update.sh takes automatically before every deploy, available here to
# run any time (e.g. before a manual restore, or just before poking at data).
#
# Usage: backup.sh <data_dir>

DATA_DIR="${1:?data dir required}"
DB_NAME="splitsmart.db"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_DIR="${SCRIPT_DIR}/../database_backups"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")

mkdir -p "$BACKUP_DIR"

if [ ! -f "${DATA_DIR}/${DB_NAME}" ]; then
  echo "Error: database not found at ${DATA_DIR}/${DB_NAME}"
  exit 1
fi

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "Error: sqlite3 is required to take a consistent backup of a WAL database."
  echo "Install it with: apt-get install -y sqlite3"
  echo "Do NOT fall back to 'cp' — see README.md."
  exit 1
fi

DEST="${BACKUP_DIR}/${DB_NAME}_${TIMESTAMP}"

echo "Creating backup from ${DATA_DIR}/${DB_NAME}..."
sqlite3 "${DATA_DIR}/${DB_NAME}" ".backup '${DEST}'"

# The .backup destination inherits WAL mode and arrives with -wal/-shm
# sidecars. Collapse it to one self-contained file so it can't be copied
# around incompletely.
sqlite3 "$DEST" "PRAGMA journal_mode=DELETE;" > /dev/null
rm -f "${DEST}-wal" "${DEST}-shm"

echo "Verifying backup integrity..."
if [ "$(sqlite3 "$DEST" "PRAGMA integrity_check")" != "ok" ]; then
  echo "Error: integrity check FAILED for ${DEST}. Backup is not trustworthy."
  exit 1
fi

echo "Database backed up to ${DEST}"
