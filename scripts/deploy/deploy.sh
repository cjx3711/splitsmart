#!/bin/bash
set -euo pipefail

# Builds the production image, ships it to the server, and (re)starts the
# container there with the database preserved. Run this from the repo root
# or anywhere; it cds to the repo root itself.
#
# Requires two local, gitignored files — see the .example templates:
#   .env.deploy   where/how to deploy (host, dirs, port)
#   .env.prod     the app's own runtime secrets
#
# Usage: scripts/deploy/deploy.sh

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

DEPLOY_ENV=".env.deploy"
APP_ENV=".env.prod"
IMAGE_NAME="splitsmart-app"
CONTAINER_NAME="splitsmart-container"
TAR_NAME="${IMAGE_NAME}.tar"

# --- Load and validate .env.deploy ------------------------------------------

if [ ! -f "$DEPLOY_ENV" ]; then
  echo "Error: $DEPLOY_ENV not found."
  echo "Copy .env.deploy.example to .env.deploy and fill in your server details."
  exit 1
fi

# shellcheck disable=SC1090
set -a
source "$DEPLOY_ENV"
set +a

for var in DEPLOY_HOST DEPLOY_DIR DEPLOY_DATA_DIR DEPLOY_ENV_FILE DEPLOY_PORT; do
  if [ -z "${!var:-}" ]; then
    echo "Error: $var is not set in $DEPLOY_ENV."
    exit 1
  fi
done

# --- Load and validate .env.prod --------------------------------------------

if [ ! -f "$APP_ENV" ]; then
  echo "Error: $APP_ENV not found."
  echo "Copy .env.prod.example to .env.prod and fill in your production secrets."
  exit 1
fi

# Reads the value of KEY=... from a file, last occurrence wins, ignoring
# comments and blank values. Does not attempt to be a shell parser: the file
# is also used as a Docker --env-file, whose own rules (no quotes, no
# expansion) already keep it simple.
env_value() {
  local key="$1" file="$2"
  grep -E "^${key}=" "$file" | tail -n1 | cut -d'=' -f2-
}

missing=()
for var in SESSION_SECRET APP_ORIGIN; do
  value="$(env_value "$var" "$APP_ENV")"
  if [ -z "$value" ]; then
    missing+=("$var")
  fi
done
if [ ${#missing[@]} -ne 0 ]; then
  echo "Error: $APP_ENV is missing a value for: ${missing[*]}"
  echo "See .env.prod.example."
  exit 1
fi

secret="$(env_value SESSION_SECRET "$APP_ENV")"
if [ "${#secret}" -lt 32 ]; then
  echo "Error: SESSION_SECRET in $APP_ENV must be at least 32 characters."
  exit 1
fi

# These are fixed by the Dockerfile and the deploy scripts. A value here
# would silently override them via --env-file and break the deploy (wrong
# port, or a database path that isn't the mounted volume).
for var in NODE_ENV PORT DATABASE_PATH; do
  if grep -qE "^${var}=" "$APP_ENV"; then
    echo "Error: $APP_ENV sets $var, which the deploy scripts manage. Remove that line."
    exit 1
  fi
done

# At most one mail provider, and never half of one.
resend_key="$(env_value RESEND_API_KEY "$APP_ENV")"
resend_from="$(env_value RESEND_FROM_ADDRESS "$APP_ENV")"
postmark_token="$(env_value POSTMARK_SERVER_TOKEN "$APP_ENV")"
postmark_from="$(env_value POSTMARK_FROM_ADDRESS "$APP_ENV")"

if [ -n "$resend_key" ] && [ -n "$postmark_token" ]; then
  echo "Error: $APP_ENV sets both Resend and Postmark credentials. Use one."
  exit 1
fi
if [ -n "$resend_key" ] && [ -z "$resend_from" ]; then
  echo "Error: RESEND_API_KEY is set without RESEND_FROM_ADDRESS."
  exit 1
fi
if [ -n "$postmark_token" ] && [ -z "$postmark_from" ]; then
  echo "Error: POSTMARK_SERVER_TOKEN is set without POSTMARK_FROM_ADDRESS."
  exit 1
fi

echo "Config OK. Deploying to ${DEPLOY_HOST}:${DEPLOY_DIR}"

# --- Telemetry (optional, local-only) ---------------------------------------
#
# SplitSmart ships with no telemetry: web/public/telemetry.js is a committed
# no-op stub. If a local .telemetry.js exists at the repo root (gitignored,
# never committed - see .gitignore), its contents replace that stub for this
# build only, then the stub is restored so the working tree stays clean.

TELEMETRY_LOCAL="$REPO_ROOT/.telemetry.js"
TELEMETRY_STUB="$REPO_ROOT/web/public/telemetry.js"

restore_telemetry_stub() {
  git -C "$REPO_ROOT" checkout -- "$TELEMETRY_STUB" 2>/dev/null || true
}

if [ -f "$TELEMETRY_LOCAL" ]; then
  echo "Injecting local .telemetry.js for this build..."
  trap restore_telemetry_stub EXIT
  cp "$TELEMETRY_LOCAL" "$TELEMETRY_STUB"
fi

# --- Build -------------------------------------------------------------------

echo "Building image for linux/amd64..."
docker buildx build --platform linux/amd64 -t "$IMAGE_NAME" . --load

echo "Saving image to ${TAR_NAME}..."
docker save "$IMAGE_NAME" -o "$TAR_NAME"

# --- Ship ----------------------------------------------------------------

echo "Ensuring remote directories exist..."
ssh "$DEPLOY_HOST" "mkdir -p '${DEPLOY_DIR}/server' '$(dirname "$DEPLOY_ENV_FILE")'"

echo "Uploading image..."
rsync -avzP "$TAR_NAME" "${DEPLOY_HOST}:${DEPLOY_DIR}/"

echo "Uploading server scripts..."
rsync -avzP "$REPO_ROOT/scripts/deploy/server/" "${DEPLOY_HOST}:${DEPLOY_DIR}/server/"

echo "Installing production secrets (mode 600)..."
TMP_REMOTE_ENV="$(ssh "$DEPLOY_HOST" mktemp)"
scp "$APP_ENV" "${DEPLOY_HOST}:${TMP_REMOTE_ENV}"
ssh "$DEPLOY_HOST" "install -m 600 -o root -g root '${TMP_REMOTE_ENV}' '${DEPLOY_ENV_FILE}' && rm -f '${TMP_REMOTE_ENV}'"

# --- Run ---------------------------------------------------------------------

echo "Running remote update..."
ssh "$DEPLOY_HOST" "chmod +x '${DEPLOY_DIR}/server/'*.sh && '${DEPLOY_DIR}/server/update.sh' '${DEPLOY_DATA_DIR}' '${DEPLOY_ENV_FILE}' '${DEPLOY_PORT}' '${IMAGE_NAME}' '${CONTAINER_NAME}'"

rm -f "$TAR_NAME"

echo "Deploy complete."
if [ -n "${DEPLOY_DOMAIN:-}" ]; then
  echo "https://${DEPLOY_DOMAIN}"
fi
