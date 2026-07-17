# Narya

A self-hosted streaming control panel (dashboard, overlays, and Twitch/OBS/Discord automation)
for a single operator.

Narya is mid-rewrite from a Bun/Express/React/SQLite app into a .NET 10 + Vue 3 app on
PostgreSQL/Redis. The original app is frozen and still runnable under `legacy/`. See
[`docs/superpowers/plans/`](docs/superpowers/plans/) for the migration roadmap and each phase's
implementation plan, and [`CLAUDE.md`](CLAUDE.md) for architecture and contributor guidance.

## Dev setup

```sh
docker compose up -d postgres redis   # local Postgres + Redis
dotnet build Narya.sln
dotnet test Narya.sln
dotnet run --project src/Narya.Api    # API on http://localhost:5000
```

```sh
cd src/Client
bun install
bun run dev                           # Vite dev server, proxies /api and /hubs to :5000
```
