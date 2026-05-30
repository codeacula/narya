FROM oven/bun:1.2 AS base
WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install

COPY . .
RUN bun run build

EXPOSE 4317 5173
CMD ["bun", "run", "dev"]
