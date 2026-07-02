FROM oven/bun:1.3.12
# better-sqlite3 is a workspace-root dep (used by apps/server). Bun install in
# any workspace pulls it in and fires its postinstall, which runs node-gyp and
# needs Python + make + g++. Install them so the mcp-rpi build doesn't fail.
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Single-stage: copy everything (filtered by .dockerignore which now excludes
# all nested node_modules), then run bun install. Earlier multi-stage with
# COPY --from=deps was losing workspace-level node_modules symlinks across
# stages because Bun creates apps/<*>/node_modules and packages/<*>/node_modules
# during install — those didn't transfer cleanly.
COPY . .
RUN bun install --frozen-lockfile

# Run as the non-root `bun` user that the image ships with (UID 1000).
RUN chown -R bun:bun /app

USER bun

WORKDIR /app/packages/mcp-rpi

ENV NODE_ENV=production
ENV MCP_HTTP_PORT=3002
EXPOSE 3002

CMD ["bun", "run", "src/http.ts"]
