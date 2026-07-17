# Narya C#/Vue Migration — Master Roadmap

> **This is the program-level roadmap, not an executable plan.** Each phase below gets its own
> detailed implementation plan (superpowers:writing-plans format) written at phase start.
> Phase 1's plan already exists: `2026-07-17-phase-1-foundation.md`.

**Goal:** Rewrite Narya from Bun/Express/React/SQLite into a C#/.NET + Vue 3 application on
the user's standard stack (DDD, event sourcing, MediatR, PostgreSQL, Redis), hostable on a
remote webserver, with a companion agent on the streaming PC for host-local integrations.

**Strategy (decided 2026-07-17):**
- **Fresh build, phased parity.** The legacy Bun app keeps running for live streams until the
  new stack reaches parity; then a one-shot data import and cutover. No cross-runtime interop.
- **Companion agent topology.** The cloud-hostable server owns Twitch (OAuth, Helix, EventSub,
  chat), Discord, automation, persistence, dashboard, and overlays. A small agent process on
  the streaming PC connects **outbound** to the server (SignalR) and executes OBS websocket,
  playerctl, and Chatterbox TTS calls locally. Media files move to server-managed storage.
- **Auth stays operator-only.** One operator token + derived HMAC overlay token, same trust
  model as today. Viewers interact through Twitch chat commands (automation triggers), which
  work 24/7 because the server is always up. No viewer web login.
- **Data import: config + history.** One-shot importer from SQLite → Postgres. Operational
  config (actions, triggers, media assets, reward groups, category modules, viewer profiles,
  settings, OAuth tokens) becomes genesis events on new streams; history (chat, stream events,
  sessions) imports as plain documents, not fabricated events.

## Tech stack (pinned)

| Concern | Choice | Version pin |
|---|---|---|
| Runtime | .NET | net10.0 |
| Mediator | MediatR | **13.0.0** (user-pinned) |
| Event store + documents | Marten (PostgreSQL) | 8.18.0 (match Apollo) |
| Cache / pub-sub | StackExchange.Redis | 2.10.1 |
| Results | FluentResults | 4.0.0 |
| Validation | FluentValidation | 12.0.0 |
| Realtime | ASP.NET SignalR | in-box |
| Frontend | Vue 3 + Pinia + vue-router + Vite, Bun toolchain | match Apollo (Vite 7, Pinia 2, @microsoft/signalr 10) |
| Tests | xUnit 2.9.3, NSubstitute, Testcontainers.PostgreSql/Redis 4.4.0, Vitest 4 | |

Version pins are floors copied from Apollo where applicable; verify current patch releases on
NuGet at execution and record what was actually installed.

**MediatR licensing note:** 12.5.0 is the last Apache-2.0 release; v13+ is dual-licensed
(free tier covers this project — no license key required, a console notice may appear).
Apollo already uses **14.0.0** under the same license family, so matching Apollo at 14 costs
nothing extra; 13.0.0 is pinned here per explicit instruction. Revisit if you want parity
with Apollo.

## Target solution layout (Apollo conventions, minus its mistakes)

```
Narya.sln
Directory.Build.props           # TFM, nullable, analyzers (Roslynator + NetAnalyzers)
Directory.Packages.props        # central package management (improvement over Apollo)
docker-compose.yaml             # postgres, redis, narya-api, caddy
src/
  Narya.Domain/                 # pure records + readonly record struct value objects; no deps
  Narya.Core/                   # ports (I*Store, I*Publisher, IObsPort, IMusicPort, ITtsPort),
                                # request/response DTOs, LoggerMessage classes, Result extensions
  Narya.Application/            # MediatR commands/queries/notifications, folder-per-feature,
                                # command+handler per file, FluentValidation validators
  Narya.Database/               # Marten config, events, Db* inline-snapshot projections, stores
  Narya.Cache/                  # Redis: caches + realtime event publisher (Redis pub/sub)
  Narya.Api/                    # single web host: REST controllers, SignalR hubs
                                # (/hubs/realtime for dashboard+overlays, /hubs/agent for the
                                # companion), auth middleware, serves Vue SPA from wwwroot
  Narya.Agent/                  # companion console/host for the streaming PC: SignalR client,
                                # OBS websocket adapter, playerctl adapter, Chatterbox adapter
  Client/                       # Vue 3 SPA (builds into Narya.Api/wwwroot)
tests/
  Narya.*.Tests/                # mirror projects; Testcontainers for Marten/Redis integration
legacy/                         # the entire current Bun app, moved intact, runnable until cutover
```

Deliberate deviations from Apollo (each is a fix for a documented Apollo weakness):
1. **MediatR pipeline behaviors from day one** — ValidationBehavior (FluentValidation →
   `Result.Fail`) and LoggingBehavior. Apollo has none.
2. **Event auto-registration** by assembly scan of an `INaryaEvent` marker — Apollo hand-lists
   `AddEventType<>` calls and has three events missing from the list.
3. **One event base contract** (`INaryaEvent`: `EventId`, `OccurredAt`) used consistently —
   Apollo's `BaseEvent` is used by some features and ignored by others.
4. **No EF Core.** Marten owns all persistence. Apollo carries a near-empty DbContext.
5. **No gRPC, single API host.** Apollo's three-host gRPC split exists for its Discord-bot
   topology; Narya needs one host + the agent, and the agent speaks SignalR.
6. **Central package management** (`Directory.Packages.props`). Apollo duplicates pins.
7. **Testcontainers integration tests** for the event-store/projection layer. Apollo mocks
   everything and never tests Marten against a real database.
8. **One mocking library** (NSubstitute). Apollo mixes Moq and NSubstitute.
9. **No blanket `try/catch → Result.Fail(ex.Message)`** — Result is for expected failures;
   unexpected exceptions bubble to an exception-handling middleware/behavior.
10. **Marker-interface notifications** (`IRealtimeNotification` with an event name + payload)
    and one generic bridge handler — not Apollo's 22-method fan-in handler.
11. **Event versioning readiness**: every event record carries a `SchemaVersion` const from the
    start so upcasting is possible later (Apollo has an open issue for this).

## Event-sourcing scope (decided)

Not everything is an aggregate. Event-source the things with meaningful lifecycles and
audit value; store telemetry as plain Marten documents:

- **Event-sourced aggregates:** AppConfig (single root stream, Apollo `ConfigurationStore`
  pattern), Action (+steps), AutomationTrigger, MediaAsset, CategoryModule, RewardGroup,
  ViewerProfile, StreamSession, GoLiveSettings, TtsSettings, LlmSettings, StreamStatus.
- **Plain documents (append-mostly telemetry):** chat messages + chat events, stream events,
  automation runs, automod holds, chatters, tag history, stream categories cache.
- **Redis:** realtime pub/sub channel(s), Twitch Helix response caches (stream status 15s,
  ad schedule 5s, Discord status 30s), cooldown state for the trigger dispatcher.

## Phases

Each phase ends with demonstrable, tested software. Write the detailed plan for a phase
only when it starts.

### Phase 1 — Foundation + first vertical slice (plan exists)
Move legacy app to `legacy/` (still runnable). Solution scaffold, CPM, analyzers,
docker-compose (postgres+redis), Marten + MediatR 13 + pipeline behaviors, Testcontainers
harness, operator/overlay token auth middleware, Redis→SignalR realtime bridge with
operator/overlay groups, event-sourced AppConfig slice (GET/PUT `/api/config` with
`*Configured` secret masking, `settings:updated` broadcast), Vue scaffold (Pinia, router,
SignalR client, token capture) showing health + config, CI workflow.

### Phase 2 — Twitch core
Broadcaster + bot OAuth (authorization-code flow, token store as event-sourced aggregate,
refresh with expiry buffer), Helix client (typed, with the caches listed above), EventSub
behind an `ITwitchEventSource` port — WebSocket transport first, webhook transport added when
deployed with public HTTPS (that's one of the reasons for hosting remotely). **Decision to
confirm at phase start:** ingest chat via EventSub `channel.chat.message` (scopes already
held; drops the IRC/tmi.js dependency entirely) instead of an IRC client library.
All 13 EventSub subscription types from the parity checklist.

### Phase 3 — Chat, events, sessions, viewers
Chat persistence (append-only events + mutable message projection with soft-delete),
moderation events, stream events with session stamping, stream session tracking
(online/offline driven), chatters, viewer profiles, whispers, AutoMod hold queue,
session shoutouts aggregation.

### Phase 4 — Automation platform
Media assets catalog (with `resolveMediaAssetForPlayback` as the single playback choke
point), Actions + steps (all 11 step types; `delayMs` relative to invocation start; run
rollup succeeded/partial/failed/skipped; skipped broadcasts nothing), trigger repository +
dispatcher (8 trigger kinds, global/user cooldowns in Redis, dedup on source event id via
unique index, bot-loop prevention, module scoping), server-owned slash commands, media-mute
master switch, redeem-once invariant test (port of `redeemOnce.test.ts`).

### Phase 5 — Companion agent + media storage
`Narya.Agent`: SignalR client with reconnect/backoff, authenticates with an agent token.
Server-side ports (`IObsPort`, `IMusicPort`, `ITtsPort`) route through the agent connection;
graceful degradation when the agent is offline (OBS status "agent disconnected", music
paused, TTS steps fail soft as `partial`). OBS adapter (scene list/switch, studio mode,
stats, stream status), playerctl poller (fingerprint-change broadcasts), Chatterbox adapter
(voices, synthesize → base64 → `tts:speak`). Media file storage moves server-side: upload
endpoint + served `/media/*` files replacing the `public/clips`+`public/sounds` disk scan;
importer copies existing files.

### Phase 6 — Dashboard frontend
Vue port of the cockpit dashboard (3 layouts, popouts), viewers pages, the full settings
tree (connections, go-live, categories, rewards, actions, automation, modules, content,
speech, AI), stream info modal, attention/ack system, toasts, service status.

### Phase 7 — Overlays + tablet
All overlay routes including the `/overlay/alerts` → text alias (OBS scene collections
reference these URLs — aliased, never deleted; unknown paths render inert transparent
notice, never the dashboard). Independent audio/video lanes on `/overlay/clips`.
Overlay placeholders (in-memory only, never persisted, literal-true set). Tablet page.

### Phase 8 — Ancillary integrations
Discord (bot status, guild/channel listing, go-live announcements with retry/terminal
tracking), go-live flow, viewer rewards (Helix CRUD + groups + colors), category modules
(generation-serialized switch coordinator; failed category lookup ≠ null category),
stream categories/tags, LLM routes (OpenAI-compatible Responses API with chat-completions
fallback), TTS settings, automatic ads, emotes (BTTV/7TV), stream status.

### Phase 9 — Data import + cutover
One-shot importer (reads SQLite via Microsoft.Data.Sqlite; config → genesis events,
history → documents; media files → server storage). Snapshot source DB with `VACUUM INTO`
first (WAL). Parity audit against the checklist below. Cutover: run new stack for a full
real stream with legacy on standby; then retire `legacy/`.

## Feature-parity checklist (from 2026-07-17 code inventory)

The authoritative surface to reproduce. Check items off as phases land.

**REST (by module → phase):** core/health/OBS/music/chat/sounds/clips/TTS routes (P2–P5,
P8) · app config (P1) · overlay token (P1) · Twitch OAuth ×6 (P2) · Helix stream-info/
preroll/chat/shoutout/whisper/timeout/ban (P2) · viewer rewards ×9 (P8) · VIPs/mods ×6 (P8)
· media assets ×5 (P4) · actions ×5 (P4) · automation triggers ×6 + slash (P4) · media mute
×2 (P4) · category modules ×7 (P8) · stream categories ×6 + tags (P8) · stream status ×2
(P8) · overlay placeholders ×2 (P7) · LLM ×3 (P8) · Discord ×6 (P8) · go-live ×4 (P8) ·
chatters (P3) · eventsub reconnect (P2) · dashboard status/viewers/chat/events/shoutouts ×9
(P3/P6) · automod ×3 (P3) · emotes (P8) · SPA static fallback (P1).

**WebSocket events (overlay-allowlisted):** chat:message, chat:moderated, music:updated,
sound:play, media:play, tts:speak, overlay:text, stream:event, stream:event:update,
status:updated, overlay:placeholders.
**Operator-only:** whisper:message, dashboard:status, settings:updated, rewards:updated,
obs:status, media:mute, discord:announce-failed, category-modules:updated, automod:held,
automod:resolved. The allowlist split maps to SignalR groups (`operator` / `overlay`).

**EventSub types:** stream.online, stream.offline, channel.update v2, channel.follow v2,
channel.subscribe, channel.subscription.gift, channel.subscription.message, channel.cheer,
channel.raid, channel.chat.notification, channel.channel_points_custom_reward_redemption.add,
channel.ad_break.begin, user.whisper.message (+ channel.chat.message if the P2 chat decision
lands).

**Invariants to carry over (each needs a test):** a redeem plays exactly once · slash
commands are server-owned and rejected server-side, never forwarded to Twitch · a category
belongs to at most one module (DB-enforced) · failed category lookup changes no remote
reward state · trigger dedup on source event id survives redelivery · `delayMs` is relative
to invocation start · skipped runs broadcast nothing · pending delays never replay after
restart · overlay placeholders never persist · secrets never reach the client
(`*Configured` booleans) · overlay token is GET-only + allowlisted · `/overlay/*` unknown
paths never render the dashboard.

**Legacy tables intentionally not ported:** chatbot_commands, reward_media,
tts_reward_enabled, alert_settings, stream_goals, sound_buttons/clip_buttons (verify the
sound/clip button routes' liveness during P4 — inventory flagged them as ambiguous).

## Risks / open items
- **Chatterbox TTS reachability** from the agent vs. server-side synthesis — resolve in P5.
- **Remote media storage** design (plain disk on the server vs. object storage) — plain disk
  volume first; revisit only if hosting demands it.
- **EventSub webhook transport** needs public HTTPS + secret validation — only after actual
  remote deployment; WebSocket transport is fine meanwhile.
- **Legacy `sounds`/`clips` button routes** may be dead code — confirm before porting.
- MediatR 13 vs Apollo's 14 — see licensing note.
