FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS builder
# python3 + make + g++ are required because better-sqlite3 (a workspace-root
# dep) fires its node-gyp postinstall during `bun install` even from this
# build context. Bun installs; Node runs the Next.js build (below); the runner
# stage has the official Node (alpine, pinned by digest) for serving the standalone output.
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
# .dockerignore must exclude **/node_modules to keep host-side links from
# leaking and stomping Bun's container-side workspace install.
# The build runs under Node, the runner's version: in this image `node` on PATH
# is Bun's fallback shim, and Next 16.3's Turbopack build crashes under Bun
# ("Expected CommonJS module to have a function wrapper", then a segfault).
COPY --from=node:22.23.4-bookworm-slim@sha256:5991875dfb80938dd8a6ba3fe3e96fd04929e70792762b3319d8caadbbe229bc /usr/local/bin/node /usr/local/bin/node
RUN /usr/local/bin/node ./node_modules/next/dist/bin/next build

# Production image — slim Node.js only. Run as the non-root `node` user
# the alpine image ships with (UID 1000); --chown on COPY ensures owned
# files arrive without an extra chown layer.
FROM node:22.23.4-alpine@sha256:ce8d97f7cfc7c5386421eb932df20a29df99b1a7f469f6157d5c9956702ffadc AS runner
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
