# Gamertown backend — multi-stage build.
# better-sqlite3 + argon2 are native modules, so the builder needs a toolchain;
# the runtime image is slim and carries only the compiled node_modules + source.
# Stick to glibc (bookworm), NOT alpine/musl, to avoid native-module rebuild pain.

# ── builder ───────────────────────────────────────────────────────────────────
FROM node:20-bookworm AS builder
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential python3 \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ── runtime ───────────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# The DB + session-key live under ./data, which is a mounted volume at runtime.
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

# Run as the unprivileged user that the node image ships with, and make sure the
# data dir exists + is owned by it (the volume mount inherits this ownership).
RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 3000
CMD ["node", "src/server.js"]

# ── dev (live-reload; selected by docker-compose.dev.yml `target: dev`) ────────
# Same compiled native modules as runtime, plus nodemon. Runs as root so it can
# read the bind-mounted src and write the data volume. Uses --legacy-watch
# (polling) because inotify file events do NOT cross Docker Desktop bind mounts
# on Windows/macOS, so `node --watch` never fires there.
FROM node:20-bookworm-slim AS dev
WORKDIR /app
ENV NODE_ENV=development
COPY --from=builder /app/node_modules ./node_modules
COPY package.json package-lock.json ./
RUN npm install -g nodemon
COPY src ./src
RUN mkdir -p /app/data
EXPOSE 3000
CMD ["nodemon", "--legacy-watch", "--watch", "src", "--ext", "js,json,html", "src/server.js"]
