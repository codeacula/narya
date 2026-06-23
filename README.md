# Streamer Tools

Local stream tooling for codeacula.

## Routes

- `http://localhost:5173/` or `/dashboard` - side-monitor dashboard
- `http://localhost:5173/tablet` - touch-first controls
- `http://localhost:5173/overlay` - transparent OBS browser source overlay

The overlay is designed for a `1920x1080` browser source, with Twitch chat in the top right and now-playing music in the bottom left.

Music display uses `playerctl` from the backend process. Install `playerctl` on the host and run the app in the same desktop session as Strawberry.
By default it reads from the `strawberry` playerctl player. Set `MUSIC_PLAYERCTL_PLAYER` if your playerctl name differs.

## Local Dev

```sh
bun install
bun run dev
```

The Vite app runs on port `5173`; the backend API and WebSocket server run on port `4317`.
Open `http://localhost:5173/tablet` on the desktop, or `http://<desktop-lan-ip>:5173/tablet` from a tablet on the same network.

## OBS Controls

Enable OBS WebSocket on port `4455`, then set `OBS_WEBSOCKET_PASSWORD` in `.env` if OBS requires a password. The backend connects to OBS on startup, keeps a live scene list/current scene state, and broadcasts OBS updates to the tablet panel.

When OBS is connected, `/tablet` shows the live OBS scene list and highlights the current program scene. When OBS is unavailable, it falls back to the `OBS_SCENES` setting so the panel layout remains testable, but OBS buttons stay disabled until the connection returns.

## Docker

```sh
docker compose up --build
```

SQLite data is persisted in `./data/streamer-tools.sqlite`.

Chat is stored in two layers:

- `chat_events` is append-only and keeps raw message and moderation events.
- `chat_messages` is the current display projection, including moderation state.

The dashboard can show moderated originals. The overlay hides moderated messages so deleted content does not stay visible on stream.

## Configuration

Copy `.env.example` to `.env` if you want to override defaults:

```sh
TWITCH_CHANNEL=codeacula
OBS_WEBSOCKET_URL=ws://127.0.0.1:4455
OBS_WEBSOCKET_PASSWORD=
MUSIC_POLL_INTERVAL_MS=2000
MUSIC_PLAYERCTL_PLAYER=strawberry
QUACK_VOLUME=0.20
TWITCH_CLIENT_ID=
TWITCH_CLIENT_SECRET=
TWITCH_USER_TOKEN=
TWITCH_BOT_USER_TOKEN=
TWITCH_REDIRECT_URI=http://localhost:5173/api/auth/twitch/callback
```

The dashboard Settings page is the primary Twitch setup path. Set `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET`, register `TWITCH_REDIRECT_URI` in your Twitch app, then use Settings to log in the broadcaster account and the separate bot account.

`TWITCH_USER_TOKEN` and `TWITCH_BOT_USER_TOKEN` are manual fallbacks for deployments that manage OAuth tokens outside the dashboard. Broadcaster credentials are used for EventSub, stream info, ads, moderation, shoutouts, and whispers. Bot credentials are used for dashboard chat sends and chat command replies.

For Docker, OBS is configured as `ws://host.docker.internal:4455` so the container can reach OBS running on the host.
Playerctl is best run locally because containers do not normally have access to the host desktop media session.
