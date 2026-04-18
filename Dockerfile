# syntax=docker/dockerfile:1.6
# Auxilo — production Docker image for Fly.io
#
# Ships the Hono HTTP server (server.js) only. The MCP server (mcp-server.js)
# runs client-side on agents' machines via `npx auxilo-mcp` and is NOT part
# of this image's runtime path.
#
# Build context note: data/ is gitignored AND .dockerignored so we never bake
# local state into the image. Runtime data lives on the Fly volume mounted
# at /app/data (see fly.toml [[mounts]]).

FROM node:20-alpine AS base

# curl is required for HEALTHCHECK. tini gives us proper signal handling so
# SIGTERM from flyctl machine stop / rolling deploy reaches node cleanly.
RUN apk add --no-cache curl tini

WORKDIR /app

# ── Dependency layer (cache-friendly) ────────────────────────────────────
# Copy only the manifest + lockfile first so that code-only changes do not
# bust the npm ci layer.
COPY package.json package-lock.json* ./

# --omit=dev: no devDependencies in the runtime image.
# --ignore-scripts: don't run arbitrary lifecycle scripts from transitive
# deps during image build.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# ── App source ───────────────────────────────────────────────────────────
# Copy the rest of the repo AFTER deps. .dockerignore keeps data/,
# node_modules/, *.log, .git, and the deploy-*.js helpers out.
COPY . .

# Ensure the data mountpoint exists. On Fly the persistent volume overlays
# this at runtime; files inside may come from tar extracts with root
# ownership (see MIGRATION-FLY.md data-restore procedure).
RUN mkdir -p /app/data

# NOTE: running as root here — Fly volumes restored from Conway tarballs
# have root-owned files that non-root `node` user can't read. Hardening
# to drop-privileges-via-entrypoint is tracked as a P1 post-pilot item;
# for pilot-of-one this is acceptable.
# USER node   # re-enable after pilot + chown fix

ENV NODE_ENV=production \
    PORT=3000

EXPOSE 3000

# Fly health checks already poll /health over HTTP, but we keep a
# container-level healthcheck as a belt-and-suspenders for `docker run`
# and for `fly machine status` visibility.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://127.0.0.1:3000/health || exit 1

# tini = PID 1 → forwards signals and reaps zombies.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
