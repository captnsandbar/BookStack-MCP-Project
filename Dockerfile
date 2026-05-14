# syntax=docker/dockerfile:1.7

# ─── Build stage ──────────────────────────────────────────────────────────────
FROM node:24-slim AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Prune devDependencies for copying into the runtime stage.
RUN npm prune --omit=dev

# ─── Runtime stage ────────────────────────────────────────────────────────────
FROM node:24-slim AS runtime
WORKDIR /app

# curl for HEALTHCHECK, ca-certificates for HTTPS upstream calls to BookStack.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# BookStack API spec is read at runtime by src/catalog.ts (relative path: ../Docs).
COPY Docs ./Docs

# Drop privileges. The data dir is the mount point for the SQLite volume.
RUN mkdir -p /app/data && \
    groupadd --system --gid 10001 mcp && \
    useradd  --system --uid 10001 --gid 10001 --no-create-home mcp && \
    chown -R mcp:mcp /app/data
USER mcp

ENV NODE_ENV=production \
    BIND_HOST=0.0.0.0 \
    LOCAL_SERVER_PORT=3000 \
    DB_FILE=/app/data/bookstack-mcp.sqlite

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -fsS http://127.0.0.1:3000/healthz || exit 1

CMD ["node", "--enable-source-maps", "dist/server.js"]
