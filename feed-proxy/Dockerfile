FROM oven/bun:1

WORKDIR /app

COPY package.json bun.lockb* ./
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
