# Feature Validation

Validated on 2026-06-23 with `bun run dev` running the Vite client on `5173` and the backend on `4317`.

## Checks run

- `bun run typecheck`
- `bun run build`
- Browser smoke checks with headless Chromium via Chrome DevTools Protocol:
  - `/dashboard` at `1440x1000`
  - `/dashboard` at `390x844`
  - `/tablet` at `1024x768`
  - `/overlay`, `/overlay/chat`, and `/overlay/nowplaying` at `1920x1080`
  - `/viewer` at `900x900`
- Backend smoke checks:
  - `GET /api/health`
  - `GET /api/dashboard/status`
  - `GET /api/chat/recent`
  - `GET /api/music/current`
  - `PUT /api/music/current`
  - `DELETE /api/music/current`
  - `GET /api/obs/status`
  - `GET /api/sounds`
- Realtime smoke check:
  - `ws://localhost:5173/socket` through the Vite proxy
  - `ws://localhost:4317/socket` directly to the backend
  - `music:updated` broadcast after manual music update and clear

## Working as expected

- Dashboard renders live backend status, shows the stream as offline, and reports Twitch login required when Twitch credentials are not configured.
- Dashboard settings view opens from the dashboard `settings` navigation button and renders Twitch, bot command, sound, runsheet, ticker, and LLM settings.
- Dashboard chat input enables after text entry. In the no-bot-token environment, submit returns the expected `Twitch bot login is required.` message.
- Tablet renders OBS scene controls from the connected local OBS WebSocket session and marks the current program scene.
- Tablet manual music controls update the backend, receive the realtime update, show `Source: manual`, and clear back to `Source: none`.
- Tablet sound buttons render the configured quack sounds.
- Overlay routes render without app chrome and use the transparent overlay page class. With no chat or music, the chat overlay is empty and now-playing shows `No music playing`.
- Viewer route renders the expected empty state: `No viewer selected`.
- The Vite WebSocket proxy and direct backend WebSocket both accept connections.

## Not working or incomplete

- Direct navigation to `/settings` does not open the settings view. It renders the dashboard view because `src/client/main.tsx` routes unknown paths to `DashboardPage`, and the settings page is only internal dashboard state. Use the dashboard `settings` button until a real `/settings` route is added.

## Not fully validated

- Live Twitch authentication, EventSub, ad schedule, stream info updates, moderation actions, shoutouts, whispers, and real chat sends were not validated because this environment does not have Twitch user or bot credentials configured.
- Real OBS scene switching and transition buttons were not clicked to avoid changing the active local OBS program scene during validation. OBS connectivity and scene listing were validated.
- LLM command execution was not validated against a live LM Studio/OpenAI-compatible endpoint.
- Audio playback was not audibly verified in headless Chromium; sound button configuration and backend endpoints were validated.
- Headless Chromium in dev mode logs transient `WebSocket connection to 'ws://localhost:5173/socket' failed: WebSocket is closed before the connection is established.` warnings during short-lived page checks. Direct WebSocket smoke tests passed through both Vite and backend endpoints.
