# One container: the Next.js standalone server, SQLite in the /data volume.
# The build needs the network (npm); the running container never does.

# node:24-bookworm-slim pinned to the image our checks ran on (Node 24.21.0, one index for linux/amd64 and
# linux/arm64), so a later push to the tag cannot change what a fork builds. To move on: read the tag's new
# digest with `docker buildx imagetools inspect node:24-bookworm-slim`, put it here, and run the checks again.
FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS base
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# better-sqlite3 ships prebuilt binaries inside its package. Without --ignore-scripts,
# npm on Linux runs node-gyp for it and fails: this slim image has no compiler.
RUN npm ci --ignore-scripts

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx next build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    HOSTNAME=0.0.0.0 \
    DATABASE_PATH=/data/portal.db
RUN mkdir /data && chown node:node /data
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/drizzle ./drizzle
COPY --from=builder --chown=node:node /app/fixtures.json ./fixtures.json
# backup.mjs, restore.mjs, purge.mjs and verify-record.mjs, for operators (README)
COPY --from=builder --chown=node:node /app/scripts ./scripts
USER node
EXPOSE 8080
VOLUME ["/data"]
# Migrations, the fixture import and the checker sessions run inside the server's
# own start-up (src/instrumentation.ts); wait for the "portal ready" line. The preload
# makes the client address the connection's own (or TRUST_PROXY_HOPS proxies' view).
CMD ["node", "--import", "./scripts/client-address.mjs", "server.js"]
