# hgc-server -- single image: API + built SPA + git (provisioning).
# Build:   docker build -t hgc-server .
# ADR-009: one application container, with PostgreSQL and Caddy alongside (compose).

FROM node:22-slim AS build
RUN corepack enable pnpm
WORKDIR /src
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/domain/package.json packages/domain/
COPY packages/contracts/package.json packages/contracts/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
# The production VM has ~450 MiB of RAM (ADR-009): let Node spill into swap
# instead of aborting (exit 134), and keep the workspace build sequential.
ENV NODE_OPTIONS=--max-old-space-size=1536
RUN pnpm --workspace-concurrency=1 build
# Self-contained production tree for the server (pruned node_modules + workspaces)
RUN pnpm --filter @hgc/server deploy --prod --legacy /out \
  && cp -r apps/server/drizzle /out/drizzle \
  && cp -r apps/web/dist /out/web

FROM node:22-slim
# git: pushing squashed refs and provisioning (GH-03)
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out /app
USER node
ENV STATIC_DIR=/app/web MIGRATE_ON_START=1 PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD curl -sf http://localhost:3000/healthz || exit 1
CMD ["node", "dist/server.js"]
