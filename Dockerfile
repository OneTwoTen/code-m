FROM oven/bun:1.3.3-slim

WORKDIR /app

COPY package.json bun.lock ./
COPY apps/mcp-server/package.json apps/mcp-server/package.json
COPY packages/adapters/package.json packages/adapters/package.json
COPY packages/core/package.json packages/core/package.json

RUN bun install --frozen-lockfile --production

COPY apps ./apps
COPY packages ./packages

ENV CODEM_WORKSPACE_ROOT=/workspace

RUN mkdir -p /workspace && chown -R bun:bun /app /workspace

USER bun

VOLUME ["/workspace"]

ENTRYPOINT ["bun", "run", "apps/mcp-server/src/main.ts"]
