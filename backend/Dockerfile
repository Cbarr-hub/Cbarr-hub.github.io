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
