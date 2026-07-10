# Streamer Tools

Local stream tooling for codeacula.

## Routes

- `http://localhost:5173/` or `/dashboard` - side-monitor dashboard
- `http://localhost:5173/tablet` - touch-first controls
- `http://localhost:5173/overlay` - transparent OBS browser source overlay
- `http://localhost:5173/overlay/clips` - centered portrait/landscape clip playback overlay
- `http://localhost:5173/overlay/sounds` - dedicated OBS browser source for TTS and sound effects

The overlay is designed for a `1920x1080` browser source, with Twitch chat in the top right and now-playing music in the bottom left.
Use `/overlay/clips` as its own `1920x1080` browser source. Clips stay centered, preserve their full frame, and scale automatically for portrait or landscape video while the rest of the source remains transparent.
Keep the sound overlay loaded as a separate OBS browser source. Broadcast TTS and sound effects play only through that source, independently of the dashboard and visual overlays.

Music display uses `playerctl` from the backend process. Install `playerctl` on the host and run the app in the same desktop session as Strawberry.
By default it reads from the `strawberry` playerctl player. Set `MUSIC_PLAYERCTL_PLAYER` if your playerctl name differs.

Text-to-Speech uses the separate Chatterbox service at `http://127.0.0.1:8008`
by default. Narya loads its registered voices from `GET /voices` and sends speech
requests to `POST /synthesize`; voice registration is managed by Chatterbox.

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
docker compose up --build -d
```

The container runs the development servers with the repository mounted at `/app`:

- Open the dashboard at `http://localhost:5173/dashboard`.
- Vite applies React and CSS changes with HMR.
- Bun restarts the backend when files under `src/server` change.
- The backend and direct API access remain available on `http://localhost:4317`.
- SQLite data remains persisted in `./data/streamer-tools.sqlite`.

Follow the development logs with:

```sh
docker compose logs -f
```

The container keeps its own `node_modules` volume instead of using host dependencies. After changing `package.json` or `bun.lock`, restart the service so its startup install refreshes that volume:

```sh
docker compose restart
```

Re-run `docker compose up --build -d` when changing the Dockerfile or Bun image. Stop the service with `docker compose stop` if it should remain stopped after the next engine restart, or remove it with `docker compose down`.

Compose uses `restart: unless-stopped`, so the service returns automatically after the container engine starts. Docker Engine or Docker Desktop must itself be enabled at boot or login. When `docker` is provided by rootless Podman, enable Podman's restart service as well:

```sh
systemctl --user enable --now podman-restart.service
```

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

Use `http://localhost:5173/api/auth/twitch/callback` for `TWITCH_REDIRECT_URI` in both Docker and direct local development.

The dashboard Settings page is the primary Twitch setup path. Set `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET`, register `TWITCH_REDIRECT_URI` in your Twitch app, then use Settings to log in the broadcaster account and the separate bot account.

`TWITCH_USER_TOKEN` and `TWITCH_BOT_USER_TOKEN` are manual fallbacks for deployments that manage OAuth tokens outside the dashboard. Broadcaster credentials are used for EventSub, stream info, ads, moderation, shoutouts, and whispers. Bot credentials are used for dashboard chat sends and chat command replies.

For Docker, OBS is configured as `ws://host.docker.internal:4455` so the container can reach OBS running on the host. The Docker default disables playerctl polling with `MUSIC_POLL_INTERVAL_MS=0` because containers do not normally have access to the host desktop media session.

For local Bun development, use `CHATTERBOX_BASE_URL=http://127.0.0.1:8008`.
For Docker, `CHATTERBOX_DOCKER_BASE_URL` defaults to
`http://host.docker.internal:8008` so the Narya container can reach the
Chatterbox app running on the host without reusing the host-only loopback URL.
Start Chatterbox with `--host 0.0.0.0 --port 8008` when using Narya in Docker;
a service bound only to `127.0.0.1` is not reachable from the container.

## License

Licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE). You may use,
modify, and share this software for any noncommercial purpose. Commercial use
requires a separate license — open an issue to discuss.
