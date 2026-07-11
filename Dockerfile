# syntax=docker/dockerfile:1

# ---- build: compile TypeScript to dist/ ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime: prod deps + git, non-root ----
FROM node:22-alpine AS runtime
# git is required (the service shells out to it); ca-certificates for HTTPS clones.
RUN apk add --no-cache git ca-certificates
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

ENV PORT=8787 \
    GITPROOF_CACHE_DIR=/data/cache \
    # Treat mounted repos as safe regardless of host ownership (per-process).
    GIT_CONFIG_COUNT=1 \
    GIT_CONFIG_KEY_0=safe.directory \
    GIT_CONFIG_VALUE_0=*

RUN mkdir -p /data/cache && chown -R node:node /data
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://localhost:8787/healthz || exit 1
CMD ["node", "dist/index.js"]
