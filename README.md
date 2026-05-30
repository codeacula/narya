# Streamer Tools

Local stream tooling for codeacula.

## Routes

- `http://localhost:5173/` or `/dashboard` - side-monitor dashboard
- `http://localhost:5173/tablet` - touch-first controls
- `http://localhost:5173/overlay` - transparent OBS browser source overlay

The overlay is designed for a `1920x1080` browser source, with Twitch chat in the top right and music/goals in the bottom left.

## Local Dev

```sh
bun install
bun run dev
```

The Vite app runs on port `5173`; the backend API and WebSocket server run on port `4317`.

## Docker

```sh
docker compose up --build
```

SQLite data is persisted in `./data/streamer-tools.sqlite`.

## Configuration

Copy `.env.example` to `.env` if you want to override defaults:

```sh
TWITCH_CHANNEL=codeacula
OBS_WEBSOCKET_URL=ws://127.0.0.1:4455
OBS_WEBSOCKET_PASSWORD=
```

For Docker, OBS is configured as `ws://host.docker.internal:4455` so the container can reach OBS running on the host.
