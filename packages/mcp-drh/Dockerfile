# mcp-drh — compiled-binary image (multi-stage).
#
# The builder compiles a self-contained single-file binary via `bun build --compile`
# (all deps bundled in → NO node_modules), then the slim runtime just runs it:
# ~3.8 GB (interpreted `bun run` + full workspace install) -> ~170 MB.
#
# Why this works where a multi-stage `COPY --from` of node_modules does NOT: Bun
# workspace symlinks don't survive a cross-stage copy (see the reverted attempts in
# the sibling Dockerfiles). A compiled binary has no node_modules to lose, so it
# sidesteps that landmine entirely. The full workspace is present in the *builder*
# (symlinks intact there) only long enough to compile; only the binary is forwarded.

FROM oven/bun:1.3.12 AS builder
WORKDIR /app
# python3/make/g++: the workspace-root better-sqlite3 fires node-gyp during bun install.
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY . .
RUN bun install --frozen-lockfile
RUN cd packages/mcp-drh && bun run build:linux

# Slim runtime — glibc base (bun-compiled binaries are glibc, NOT musl/alpine) plus
# ca-certificates for outbound HTTPS to the DRH API. Just the binary: no node_modules,
# no source, no build tooling.
FROM debian:12-slim AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /app/packages/mcp-drh/dist/rp-drh-mcp-linux-x64/rp-drh-mcp-linux /app/rp-drh-mcp
RUN useradd -u 1000 drh && chown -R drh:drh /app
USER drh

ENV NODE_ENV=production
ENV DRH_MCP_HTTP_PORT=3003
EXPOSE 3003

CMD ["/app/rp-drh-mcp"]
