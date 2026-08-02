FROM oven/bun:1.3.12 AS builder
# python3 + make + g++ are required because better-sqlite3 (a workspace-root
# dep) fires its node-gyp postinstall during `bun install` even from this
# build context. Bun runs the Next.js build directly — no separate Node
# install needed in the builder stage; the runner stage has Node 22.12-alpine
# for actually serving the standalone output.
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# Disable Next.js anonymous telemetry for the build (and any runtime invocation).
# OSS hygiene: no usage data leaves the build host.
ENV NEXT_TELEMETRY_DISABLED=1

# Copy ALL workspace package.json files so Bun sees the same workspace graph
# as the host's bun.lock (otherwise --frozen-lockfile fails on partial graph).
# Then copy the source we actually need to build (apps/web + packages/shared).
COPY package.json bun.lock* ./
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/
COPY packages/shared/package.json ./packages/shared/
COPY packages/skills/package.json ./packages/skills/
COPY packages/mcp-rpi/package.json ./packages/mcp-rpi/
COPY packages/mcp-drh/package.json ./packages/mcp-drh/
# Root postinstall hook is `git config core.fileMode false` (gated by a
# `git rev-parse --is-inside-work-tree` check); inside Docker the .git
# directory is absent so it short-circuits to a no-op. No need to COPY
# scripts/ at this stage. The sibling Dockerfiles for apps/server and
# packages/mcp-rpi do not COPY scripts/ either — consistent now.
RUN bun install --frozen-lockfile

# Now copy the actual source we need to build the Next.js app
COPY apps/web/ ./apps/web/
COPY packages/shared/ ./packages/shared/
WORKDIR /app/apps/web
# Bun workspace install creates apps/web/node_modules/.bin/next as a symlink
# back to the workspace-cached package. .dockerignore must exclude
# **/node_modules to keep host-side links from leaking and stomping this.
RUN ./node_modules/.bin/next build

# Production image — slim Node.js only. Run as the non-root `node` user
# the alpine image ships with (UID 1000); --chown on COPY ensures owned
# files arrive without an extra chown layer.
FROM node:22.12-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder --chown=node:node /app/apps/web/.next/standalone ./
# Next.js standalone output in a monorepo preserves the workspace path —
# entry is at apps/web/server.js, not at the root.
COPY --from=builder --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=node:node /app/apps/web/public ./apps/web/public

USER node

EXPOSE 3001
ENV PORT=3001
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1

CMD ["node", "apps/web/server.js"]
