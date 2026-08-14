# Pinned, not floating `1`: several Bun 1.x releases carried fetch
# connection-pool fixes, and with a floating tag the deployed runtime is
# whatever happened to be current at last build — which makes a socket-level
# bug like the Constellation ECONNRESETs impossible to reason about. Bump this
# deliberately.
FROM oven/bun:1.3.14

WORKDIR /app

# The lockfile in this repo is the text `bun.lock` (the old binary `bun.lockb`
# never matched, so `--frozen-lockfile` always fell through to a fresh resolve).
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install

COPY src ./src

RUN mkdir -p /data

ENV NODE_ENV=production

EXPOSE 3000

CMD ["bun", "run", "src/index.ts"]
