FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
# Install inside the target Linux image. Use the matching SQLite prebuilt addon
# when available; fall back to a source build without requiring host toolchains.
RUN npm ci || (apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/* \
    && npm_config_build_from_source=true npm ci)

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DB_PATH=/app/data/logs.db

WORKDIR /app
RUN mkdir -p /app/data && chown node:node /app/data

COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node public ./public

USER node
VOLUME ["/app/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || '3000') + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "dist/index.js"]
