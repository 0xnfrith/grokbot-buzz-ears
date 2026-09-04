FROM oven/bun:1
WORKDIR /opt/grokbot-ears

COPY package.json bun.lock tsconfig.json ./
COPY src ./src

RUN bun install --frozen-lockfile --production

USER bun
CMD ["bun", "run", "src/index.ts"]
