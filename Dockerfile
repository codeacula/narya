FROM oven/bun:1.2 AS deps
WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

FROM deps AS build
COPY . .
RUN bun run build

FROM oven/bun:1.2 AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=4317

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

COPY --from=build /app/dist ./dist
COPY src ./src
RUN mkdir -p data

EXPOSE 4317
CMD ["bun", "run", "start"]
