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

# curl   — required for HEALTHCHECK
# tini   — PID 1, signal handling + zombie reaping
# su-exec — drop-privileges helper used by the entrypoint to chown-then-
#          exec-as-node (cheaper than gosu, statically linked)
RUN apk add --no-cache curl tini su-exec

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

# Entrypoint script: runs as root, chowns /app/data to node, then
# exec's node under the node user via su-exec. This is the correct
# security posture — root is held only for the ~100ms chown window.
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Container runs as root at entry, entrypoint drops to node via su-exec.
# Do NOT add `USER node` — it would prevent the entrypoint from chowning.

ENV NODE_ENV=production \
    PORT=3000

EXPOSE 3000

# Fly health checks already poll /health over HTTP, but we keep a
# container-level healthcheck as a belt-and-suspenders for `docker run`
# and for `fly machine status` visibility.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://127.0.0.1:3000/health || exit 1

# tini (PID 1) → docker-entrypoint (as root) → su-exec → node (as node).
# Full signal chain preserved for clean SIGTERM handling.
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server.js"]
