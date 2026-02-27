FROM oven/bun:1

WORKDIR /app

COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile || bun install

COPY src ./src

RUN mkdir -p /data

ENV NODE_ENV=production

EXPOSE 3000

CMD ["bun", "run", "src/index.ts"]
