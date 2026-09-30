# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Build stage: compile TypeScript to dist/ with the full dev dependency tree.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

# Copy manifests first so the dependency layer is cached independently of source.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---------------------------------------------------------------------------
# Runtime stage: production dependencies only.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

# node:alpine ships a `node` user (uid 1000) already.
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/node_modules ./node_modules
# public/ must sit as a sibling of dist/ -- src/server.ts resolves it as
# <dirname>/../public, which holds for both src/server.ts and dist/server.js.
COPY --chown=node:node public ./public

USER node
EXPOSE 3000

# The health check hits /healthz, which touches neither Postgres nor the LLM, so
# a failing dependency shows up as an unhealthy container rather than a restart
# loop. Liveness and readiness are deliberately different endpoints; see
# routes/health.ts and the README.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
