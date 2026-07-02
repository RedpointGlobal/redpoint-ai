FROM oven/bun:1.3.12
# python3 + make + g++ are required by better-sqlite3's node-gyp postinstall.
# nodejs is required at *runtime* (not just build) so seed.ts can invoke
# drizzle-kit on first start to apply the SQLite schema. drizzle-kit uses
# better-sqlite3's Node-native bindings, which Bun can't dlopen — Node can.
RUN apt-get update && apt-get install -y python3 make g++ nodejs && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Single-stage: copy everything (filtered by .dockerignore which excludes all
# nested node_modules), then run bun install. The full workspace must be
# present at install time for Bun to create workspace-level node_modules
# symlinks correctly (apps/server/node_modules/<dep> → ../../../node_modules/.bun/...).
# Earlier multi-stage attempts dropped these symlinks and the runtime couldn't
# resolve workspace deps like @hono/zod-validator.
COPY . .
RUN bun install --frozen-lockfile

# /app/data is the narrow volume mount for SQLite persistence (see compose).
# Create it now and chown the whole tree to the non-root `bun` user that the
# image ships with so the runtime can read source + write DB without root.
RUN mkdir -p /app/data && chown -R bun:bun /app

USER bun

WORKDIR /app/apps/server

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["bun", "run", "src/index.ts"]
