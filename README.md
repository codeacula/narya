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
Both bind to loopback by default, so `http://localhost:5173/tablet` works on the desktop with no further setup.

## Access from other devices (tablet, phone)

The API can ban viewers, drive OBS, rewrite Twitch rewards, and read your credentials, so it is never served
off-box unauthenticated. To reach it from a tablet on the same network:

1. Set a token in `.env`: `DASHBOARD_TOKEN=$(openssl rand -hex 32)`.
2. Set `HOST=0.0.0.0` in `.env`.
3. Open `http://<desktop-lan-ip>:5173/tablet?token=<DASHBOARD_TOKEN>` once. The token is saved to the
   device's localStorage and stripped from the URL.

Setting `HOST` without `DASHBOARD_TOKEN` refuses to start rather than exposing an unauthenticated control plane.

### Overlay (OBS browser source) URLs

An OBS browser source URL is a long-lived credential that sits in your scene collection, so overlays get their
own **read-only** token instead of the operator's. It grants the handful of GETs the overlays read and a
WebSocket that only carries what they render — never whispers, AutoMod holds, or credential writes.

Fetch it with the dashboard running:

```sh
curl -s -H "x-dashboard-token: $DASHBOARD_TOKEN" http://localhost:4317/api/auth/overlay-token
```

Then point OBS at `http://localhost:5173/overlay?token=<overlay-token>` (same for `/overlay/clips`,
`/overlay/sounds`). The overlay token is derived from `DASHBOARD_TOKEN`, so rotating the operator token
rotates it too. Existing browser sources carrying the operator token keep working — update them to the
overlay token to drop the privileges they don't need.

## OBS Controls

Enable OBS WebSocket on port `4455`, then set the OBS WebSocket URL and password in Settings if OBS requires them. The backend connects to OBS on startup, keeps a live scene list/current scene state, and broadcasts OBS updates to the tablet panel.

OBS is the source of truth for which scenes exist, so the dashboard and `/tablet` show no scene buttons while it is disconnected. Which scenes become buttons is decided by the **OBS scene prefix** in Settings (default `Scene - `): only scenes starting with it get a button, and the prefix is stripped from the label, so `Scene - Starting` reads as `Starting`. An optional numeric prefix after it (`Scene - 01 - Starting`) lets you force the button order from within OBS. Leave the prefix empty to switch between every scene.

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

Almost everything is configured from **Settings → "Connections & credentials"** and stored in the database (`data/streamer-tools.sqlite`): the Twitch channel and client credentials, OBS WebSocket URL and password, the OBS scene prefix, Discord, the Chatterbox URL, music polling, and sound volume. The app boots fine with none of it set, and saving reconnects only the affected services — no restart.

`.env` holds only what cannot come from the database. Copy `.env.example` to `.env`:

```sh
PORT=4317
# HOST=0.0.0.0            # exposes the API beyond loopback; REQUIRES DASHBOARD_TOKEN
# DASHBOARD_TOKEN=        # openssl rand -hex 32
VITE_BACKEND_ORIGIN=http://localhost:4317
VITE_BACKEND_WS_ORIGIN=http://localhost:4317
```

`TWITCH_REDIRECT_URI` and `DISCORD_REDIRECT_URI` are also read from the environment, but only as overrides — they default to `http://localhost:5173/api/auth/{twitch,discord}/callback`, which is correct for both Docker and direct local development. They cannot be derived, because they must match what is registered in your Twitch/Discord developer console character for character.

There is no `.env` seeding. `TWITCH_CLIENT_ID`, `OBS_SCENES`, `QUACK_VOLUME` and friends used to be read once on first boot to populate the database and then ignored forever; they have been removed, because a variable consulted once and never again reads like live configuration and is not.

Twitch setup: put the client ID and secret into Settings, register the redirect URI in your Twitch app, then use Settings to log in the broadcaster account and the separate bot account. OAuth is the only way in — the old `TWITCH_USER_TOKEN` / `TWITCH_BOT_USER_TOKEN` environment fallbacks are gone, as a pasted token carried no refresh token and no expiry, so it silently rotted while still reporting itself as authenticated. Broadcaster credentials are used for EventSub, stream info, ads, moderation, shoutouts, and whispers; bot credentials for dashboard chat sends and chat command replies.

For Docker, set the OBS URL to `ws://host.docker.internal:4455` in Settings so the container can reach OBS on the host, and set music polling to `0` — containers do not normally have access to the host desktop media session.

Set the Chatterbox URL in Settings: `http://127.0.0.1:8008` for local Bun development, `http://host.docker.internal:8008` for Docker. Start Chatterbox with `--host 0.0.0.0 --port 8008` when using Narya in Docker; a service bound only to `127.0.0.1` is not reachable from the container.

## License

Licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE). You may use,
modify, and share this software for any noncommercial purpose. Commercial use
requires a separate license — open an issue to discuss.
