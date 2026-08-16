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

# Stamped by CI (`flyctl deploy --build-arg GIT_COMMIT_SHA=...`) and surfaced on
# /health, so a post-deploy smoke check can prove this build is the one serving.
# Declared after the source copy so it never busts the dependency layer cache.
ARG GIT_COMMIT_SHA=dev
ENV GIT_COMMIT_SHA=$GIT_COMMIT_SHA

ENV NODE_ENV=production

EXPOSE 3000

CMD ["bun", "run", "src/index.ts"]
