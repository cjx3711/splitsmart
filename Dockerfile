# Single-container deploy: Node serves the API and the built frontend.
# SQLite lives on a mounted volume at /data.

FROM node:22-bookworm-slim AS build

WORKDIR /app

# better-sqlite3 compiles from source when no prebuild matches the platform.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

COPY . .
RUN yarn build:web && yarn build:api

# ---------------------------------------------------------------------------

FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production && yarn cache clean

RUN apt-get purge -y python3 make g++ && apt-get autoremove -y

COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist
COPY migrations ./migrations

# The database must outlive the container.
VOLUME ["/data"]
ENV DATABASE_PATH=/data/splitsmart.db

EXPOSE 5545

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://localhost:5545/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Migrations run on every boot; they are forward-only and idempotent.
CMD ["sh", "-c", "node dist/src/db/migrate.js && node dist/src/db/seed.js && node dist/src/server.js"]
