# Phase 2: Twitch Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Port Narya's Twitch integration to the C# backend — OAuth for the broadcaster + bot accounts, an event-sourced token store, a typed Helix client, and the EventSub WebSocket source behind a port — producing domain events the later automation/chat/session layers consume.

**Architecture:** Twitch lives in a new `Narya.Twitch` project (referenced by Api; depends on Core + Database + Cache). OAuth tokens are an event-sourced aggregate (Broadcaster/Bot), matching the AppConfig pattern. Helix is a typed `HttpClient`-based client behind `IHelixClient`; EventSub is behind `ITwitchEventSource` so the WebSocket transport can later be swapped for the webhook transport when hosted with public HTTPS. All external HTTP/WS is mocked in tests — **no live Twitch calls**; live verification is deferred to the operator.

**Tech Stack:** .NET 10, Marten event sourcing, MediatR 13, StackExchange.Redis (Helix response caches + cooldowns), System.Net.Http, System.Net.WebSockets (ClientWebSocket), Testcontainers where a real store is needed, NSubstitute + a fake HTTP handler for Helix tests.

## Global Constraints
- MediatR pinned **13.0.0**; net10.0; `Nullable`+`ImplicitUsings`; all versions in `Directory.Packages.props` (no inline).
- FluentResults `Result<T>` for expected failures; no blanket `catch(Exception)→Result.Fail`.
- **No live Twitch network calls in code paths exercised by tests.** Helix client takes an injectable `HttpMessageHandler`; EventSub takes an injectable WebSocket abstraction. Tests use fakes.
- The two OAuth scope lists are copied VERBATIM from legacy (below) — a missing scope silently breaks a Helix call.
- Secrets (`client_secret`, access/refresh tokens) NEVER reach the client. Auth status exposes booleans + expiry + missing-scope names only.
- `settings:updated`-style realtime events go through the Phase 1 `IRealtimePublisher`. New WS event names that overlays may receive must be added to `RealtimeEventNames.OverlayAllowlist`; operator-only events (whisper:message, dashboard-ish) must NOT.
- Commit `feat:`/`fix:`/`test:` + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer. Build 0/0; full `dotnet test Narya.sln` green.

### Verbatim scope lists (from legacy/src/server/twitch/auth.ts:9-32)
Broadcaster (`REQUIRED_TWITCH_OAUTH_SCOPES`): `moderator:read:followers`, `moderator:read:chatters`, `channel:read:subscriptions`, `bits:read`, `channel:manage:redemptions`, `channel:read:ads`, `channel:edit:commercial`, `channel:manage:broadcast`, `moderator:manage:banned_users`, `moderator:manage:automod`, `moderator:manage:shoutouts`, `channel:manage:vips`, `channel:manage:moderators`, `user:read:chat`, `user:write:chat`, `user:manage:whispers`, `user:read:whispers`.
Bot (`REQUIRED_TWITCH_BOT_OAUTH_SCOPES`): `user:read:chat`, `user:write:chat`.

### CHAT TRANSPORT DECISION (confirmed at phase start)
Ingest chat via **EventSub `channel.chat.message` v1** (condition `{broadcaster_user_id: bid, user_id: bid}`) using the broadcaster token's existing `user:read:chat` scope — dropping tmi.js/IRC. Moderation coverage (delete/timeout/ban/clear) is added as additional EventSub subscriptions: `channel.chat.message_delete` v1, `channel.chat.clear` v1, `channel.chat.clear_user_messages` v1, and `channel.moderate` v2 (for ban/timeout with reasons; requires `moderator:read:*`/`moderator:manage:*` scopes already held). This is one transport (EventSub), no second socket. Keep the legacy `channel.chat.notification` (watch_streak) handling.

---

## File Structure (Phase 2)
```
src/Narya.Twitch/                        NEW project (refs Core, Domain, Database, Cache)
  NaryaTwitch.cs                         marker (non-static sealed — will be assembly-scanned)
  ServiceCollectionExtensions.cs         AddNaryaTwitch(...)
  Scopes.cs                              the two verbatim scope lists
  Oauth/
    TwitchOAuthOptions.cs                clientId/secret (from AppConfig), redirect URIs (from Narya.Api config)
    ITwitchOAuthClient.cs / TwitchOAuthClient.cs   token exchange + refresh (HttpClient)
    TwitchAuthStatus.cs                  the 8-field status DTO
  Tokens/
    Events/TwitchTokenEvents.cs          INaryaEvent records
    DbTwitchToken.cs                     Marten snapshot per provider stream
    ITwitchTokenStore.cs / TwitchTokenStore.cs
    ITwitchCredentials.cs / TwitchCredentials.cs   resolve+refresh, header builders, scope checks, app token
  Helix/
    IHelixClient.cs / HelixClient.cs     typed endpoint methods
    HelixModels.cs                       response record types
    HelixCaches.cs                       stream-status(15s)/ad-schedule(5s) via Redis or in-memory
  EventSub/
    ITwitchEventSource.cs                port (start/stop/status)
    TwitchEventSubWebSocket.cs           ClientWebSocket transport, session lifecycle, generation guard
    IEventSubSubscriber.cs / EventSubSubscriber.cs   POST /eventsub/subscriptions (Helix)
    EventSubMessages.cs                  metadata/payload envelope records
    EventSubDispatcher.cs                event.type → domain notification mapping
    EventSubSubscriptions.cs             the subscription type+version+condition table
  Chat/
    ChatMessageModels.cs                 ChatMessage/ChatModerationEvent domain shapes (Core-level DTOs)
    IChatRoleResolver.cs / ChatRoleResolver.cs   badges → Role (port of roles.ts)
src/Narya.Api/Controllers/TwitchAuthController.cs   OAuth routes (callback EXEMPT from token auth)
tests/Narya.Twitch.Tests/                NEW test project
```

---

### Task 1: `Narya.Twitch` project + scopes + token aggregate

**Files:** Create `src/Narya.Twitch/*` (csproj, `NaryaTwitch.cs` marker sealed non-static, `Scopes.cs`, `Tokens/Events/TwitchTokenEvents.cs`, `Tokens/DbTwitchToken.cs`, `Tokens/ITwitchTokenStore.cs`, `Tokens/TwitchTokenStore.cs`); `tests/Narya.Twitch.Tests/*` with `Tokens/TwitchTokenStoreTests.cs`. Modify `Narya.sln`, `Directory.Packages.props` (if new pkgs), `src/Narya.Api` reference.

**Interfaces:**
- Produces `TwitchProvider` enum `{ Broadcaster, Bot }`.
- `TwitchToken` domain record: `string AccessToken, string? RefreshToken, IReadOnlyList<string> Scopes, string? TokenType, DateTimeOffset? ExpiresAt`.
- `ITwitchTokenStore { Task<Result<TwitchToken?>> GetAsync(TwitchProvider, CancellationToken); Task<Result> SaveAsync(TwitchProvider, TwitchToken, CancellationToken); Task<Result> DeleteAsync(TwitchProvider, CancellationToken); }` — event-sourced, one Marten stream per provider (deterministic stream id per provider, like AppConfig RootId).
- `Scopes.Broadcaster` / `Scopes.Bot` (the verbatim `IReadOnlyList<string>`).

- [ ] **Step 1: Failing test** `TwitchTokenStoreTests` (`[Collection("postgres")]`, `PostgresFixture` from Phase 1, `NaryaMartenConfig.Configure` must register the new events too — see Step 3):
  - `GetReturnsNullWhenNoToken` → Broadcaster get → Ok(null).
  - `SaveThenGetRoundTrips` → save a token (access, refresh, scopes=Scopes.Broadcaster, expiry) → get returns equal values; Bot provider is independent (saving Broadcaster doesn't affect Bot).
  - `DeleteRemovesToken` → save then delete → get returns null. (Model delete as a `TwitchTokenClearedEvent` appended to the stream; the projection folds to null/empty — do NOT hard-delete the stream.)
- [ ] **Step 2:** Run → FAIL (types missing). Create the project, add to sln, reference from Api, `dotnet add tests/Narya.Twitch.Tests reference src/Narya.Twitch` + `src/Narya.Database` (for NaryaMartenConfig) + `Marten`, `Testcontainers.PostgreSql`, NSubstitute, xunit via CPM.
- [ ] **Step 3:** Implement events (`TwitchTokenUpdatedEvent : INaryaEvent` with the token fields nullable-for-unchanged is unnecessary here — a token save is a full replacement, so carry ALL fields; `TwitchTokenClearedEvent : INaryaEvent`), `DbTwitchToken` (Create/Apply; a `Cleared` event folds to an empty/tombstoned projection whose `explicit operator TwitchToken?` returns null), `TwitchTokenStore` (stream id = a fixed Guid per provider — e.g. derive via `Guid` v5-style or two hardcoded Guids; append event; project). **Register the new events**: the events live in `Narya.Twitch`, but `NaryaMartenConfig.Configure` (Narya.Database) scans only `typeof(NaryaDatabase).Assembly`. FIX: make `NaryaMartenConfig.Configure` also scan additional assemblies — add an overload/mechanism so `AddNaryaTwitch` contributes its event assembly (e.g. `NaryaMartenConfig.Configure(options, params Assembly[] extra)` or a registry). The test's `CreateStore` must register the Twitch events too. Verify the projection is registered (`Snapshot<DbTwitchToken>(Inline)`).
- [ ] **Step 4:** Test green; full suite green; build 0/0.
- [ ] **Step 5:** Commit `feat: event-sourced Twitch OAuth token store (broadcaster + bot)`.

### Task 2: OAuth client (token exchange + refresh) + credential resolution

**Files:** Create `Oauth/ITwitchOAuthClient.cs`, `Oauth/TwitchOAuthClient.cs`, `Oauth/TwitchOAuthOptions.cs`, `Tokens/ITwitchCredentials.cs`, `Tokens/TwitchCredentials.cs`; tests `Oauth/TwitchOAuthClientTests.cs`, `Tokens/TwitchCredentialsTests.cs`.

**Interfaces:**
- `ITwitchOAuthClient` — `Task<Result<TwitchTokenResponse>> ExchangeCodeAsync(string code, string redirectUri, CancellationToken)` and `Task<Result<TwitchTokenResponse>> RefreshAsync(string refreshToken, CancellationToken)` and `Task<Result<TwitchTokenResponse>> ClientCredentialsAsync(CancellationToken)`. POSTs to `https://id.twitch.tv/oauth2/token` form-encoded; `client_id`/`client_secret` from AppConfig via injected accessor. `TwitchTokenResponse { string? AccessToken, string? RefreshToken, int? ExpiresIn, IReadOnlyList<string>? Scope, string? TokenType, string? Error, string? Message }`.
- `ITwitchCredentials` — resolves a usable access token per provider with **lazy refresh** (refresh when `ExpiresAt == null || ExpiresAt <= now + 60s`; buffer const `TokenExpiryRefreshBuffer = TimeSpan.FromSeconds(60)`), persists refreshed tokens via the store, and exposes: `Task<Result<string>> GetAccessTokenAsync(TwitchProvider, CancellationToken)`; `Task<Result<string>> GetAppAccessTokenAsync(CancellationToken)` (client_credentials, IN-MEMORY cache only, no store, re-request on expiry); `Task<Result<TwitchActionCredentials>> GetActionCredentialsAsync(IReadOnlyList<string> requiredScopes, CancellationToken)` returning `{ ClientId, AccessToken, BroadcasterId }` — fails `Result.Fail` (mapped to 401) if no broadcaster token, and (403) listing missing scopes if any required scope absent from the stored token's scopes. `IReadOnlyList<string> MissingScopes(TwitchProvider, IReadOnlyList<string> required)`.
- The HTTP handler is injectable (`IHttpClientFactory` named client or a ctor `HttpMessageHandler`) so tests use a fake returning canned token JSON.

- [ ] Step 1: Failing tests: OAuth client — a fake handler returns `{access_token, refresh_token, expires_in:3600, scope:[...], token_type:"bearer"}` for `grant_type=authorization_code`; assert ExchangeCodeAsync parses it; a `{error, message}` body → Result.Fail with the message. Refresh — assert the POST body has `grant_type=refresh_token` + the refresh token. Credentials — with a stored broadcaster token expiring in 30s, GetAccessToken triggers a refresh (fake handler returns a new token) and persists it; with a token fresh for 1h, no refresh call is made (fake handler asserts zero refresh POSTs); MissingScopes computes the set difference; GetActionCredentials fails when a required scope is absent.
- [ ] Step 2: Run → FAIL. Step 3: Implement. Broadcaster-id resolution (`GET /helix/users` no query with the broadcaster token → data[0].id) is cached; put it here or in Task 4's Helix client and have credentials call it — keep it in Task 4 (`IHelixClient.GetAuthenticatedUserAsync`) and inject; for Task 2 tests, substitute the broadcaster-id resolver. Step 4: green + build. Step 5: Commit `feat: Twitch OAuth token exchange, refresh, and credential resolution`.

### Task 3: OAuth routes (authorize, callback, status, sign-out)

**Files:** Create `src/Narya.Api/Controllers/TwitchAuthController.cs`, `Oauth/TwitchAuthStatus.cs`; modify `DashboardTokenMiddleware` exempt-paths to add `/api/auth/twitch/callback` (like legacy). Tests `tests/Narya.Api.Tests/Twitch/TwitchAuthControllerTests.cs` (WebApplicationFactory, SkipInfrastructure — substitute `ITwitchOAuthClient`+`ITwitchTokenStore`).

**Interfaces:**
- `GET /api/auth/twitch` and `GET /api/auth/twitch/bot` → 302 to `https://id.twitch.tv/oauth2/authorize?...` with `client_id, redirect_uri, response_type=code, scope=<space-joined>, state=<account>:<guid>, [force_verify=true if ?force=1]`; sets httpOnly cookie `narya_twitch_oauth_state` = the guid (sameSite=Lax, secure, path=/api/auth/twitch/callback, 10min). Operator-only (not overlay-allowlisted).
- `GET /api/auth/twitch/callback` → EXEMPT from dashboard-token auth (protected by state cookie). Validates state cookie vs `state` query's guid part; exchanges code; persists token; for the `user`/broadcaster account, triggers an EventSub reconnect (inject `ITwitchEventSource.Reconnect()` — a no-op stub until Task 5 lands, then wired). Redirects to `/`. 400 on error/invalid state, 500 if client secret unset.
- `GET /api/auth/twitch/status` → operator-only → `TwitchAuthStatus` (8 fields: `TwitchAuthenticated`, `TwitchAuthSource` ("oauth"|null), `TwitchTokenExpiresAt` (ISO|null), `TwitchMissingScopes` string[], + the 4 bot equivalents). Computed from stored tokens (no live Twitch call).
- `DELETE /api/auth/twitch` / `DELETE /api/auth/twitch/bot` → operator-only → clears the provider token (store DeleteAsync), returns `{ok:true, ...status}`.

- [ ] Steps: failing WAF tests (authorize returns 302 with the right scope param + sets the state cookie; callback with mismatched state → 400; callback with valid state exchanges + persists (substituted client/store) + 302 to /; status reflects a stored token's expiry + missing scopes; DELETE clears). Implement. Wire the callback→EventSub-reconnect via an injected `ITwitchEventSource` (define the interface now as a stub if Task 5 isn't done; in subagent-driven order Task 5 is later, so define `ITwitchEventSource` minimally here and implement in Task 5). Green + build. Commit `feat: Twitch OAuth authorize/callback/status/sign-out routes`.

### Task 4: Helix client (typed) + response caches

**Files:** `Helix/IHelixClient.cs`, `Helix/HelixClient.cs`, `Helix/HelixModels.cs`, `Helix/HelixCaches.cs`; tests `Helix/HelixClientTests.cs` (fake HttpMessageHandler with canned Helix JSON).

**Interfaces:** `IHelixClient` methods covering the legacy inventory, each taking resolved credentials/token internally via `ITwitchCredentials`:
- `GetAuthenticatedUserAsync(TwitchProvider)` → `{ Id, Login }` (`GET /helix/users`).
- `GetBroadcasterIdAsync()` (cached), `ResolveUserIdAsync(login)`.
- `GetChannelInfoAsync()` → `{ BroadcasterName, GameId, GameName, Title, Tags[] }` (`GET /helix/channels`).
- `UpdateChannelInfoAsync(title, gameId, tags[])` (`PATCH /helix/channels`, scope `channel:manage:broadcast`).
- `GetStreamStatusAsync()` → `{ StartedAt?, ViewerCount? }` (`GET /helix/streams`, **15s cache**).
- `GetAdScheduleAsync()` → the ad fields (`GET /helix/channels/ads`, **5s cache**, scope `channel:read:ads`).
- `SearchCategoriesAsync(query)`, `GetGameByIdAsync(id)`.
- `RunCommercialAsync(lengthSeconds=180)` (single-flight dedup), `SendChatMessageAsync(sender: Broadcaster|Bot, message)` (parse `is_sent`/`drop_reason`→422), `SendShoutoutAsync(toBroadcasterId)`, `SendWhisperAsync(toUserId, message)` (500-char cap), `BanOrTimeoutAsync(userId, duration?, reason?)`, `ResolveAutomodMessageAsync(msgId, allow|deny)` (404→gone), chatters, VIPs/mods list+add+remove, followers/subscription lookups.
- Custom-reward CRUD can live here or in a Phase 8 viewer-rewards module — **defer reward CRUD to Phase 8**; Task 4 covers everything else.

- [ ] Steps: failing tests using a fake handler that pattern-matches request URL+method and returns canned JSON, asserting: URL/params/headers correct (Client-Id + Bearer), response parsed, the 15s/5s caches return the cached value without a second HTTP call within the window (inject a controllable clock), `SendChatMessage` with `is_sent:false` → Result.Fail(422-mapped). Implement. Green + build. Commit `feat: typed Twitch Helix client with stream-status and ad-schedule caches`.

### Task 5: EventSub WebSocket source (port + transport + subscriptions + generation guard)

**Files:** `EventSub/ITwitchEventSource.cs`, `EventSub/TwitchEventSubWebSocket.cs`, `EventSub/IEventSubSubscriber.cs`, `EventSub/EventSubSubscriber.cs`, `EventSub/EventSubMessages.cs`, `EventSub/EventSubSubscriptions.cs`; tests `EventSub/EventSubWebSocketTests.cs` (fake WebSocket abstraction feeding canned frames), `EventSub/EventSubSubscriptionsTests.cs`.

**Interfaces:**
- `ITwitchEventSource { Task StartAsync(CancellationToken); Task StopAsync(); Task ReconnectAsync(); EventSubStatus Status { get; } }` — hosted via a `BackgroundService` in the Api host (guarded by SkipInfrastructure so tests don't open a socket).
- A WebSocket abstraction `IWebSocketConnection` (Connect/ReceiveAsync/CloseAsync) with a `ClientWebSocket` impl and a fake for tests — the transport MUST be injectable so tests feed frames without a network.
- `EventSubSubscriptions.All` — the table: lifecycle (`stream.online`/`stream.offline` v1), interaction (`channel.update` v2, `channel.follow` v2, `channel.subscribe` v1, `channel.subscription.gift` v1, `channel.subscription.message` v1, `channel.cheer` v1, `channel.raid` v1, `channel.chat.notification` v1, `automod.message.hold` v2, `automod.message.update` v2, **`channel.chat.message` v1**, **`channel.chat.message_delete` v1**, **`channel.chat.clear` v1**, **`channel.chat.clear_user_messages` v1**, **`channel.moderate` v2**), optional/best-effort (`channel.channel_points_custom_reward_redemption.add` v1, `channel.ad_break.begin` v1, `user.whisper.message` v1). Each with its condition builder (bid, and `user_id`/`moderator_user_id` where legacy uses them; chat subs use `{broadcaster_user_id: bid, user_id: bid}`).
- Session lifecycle: `session_welcome` (set keepalive=(kt+10)s, on initial connect resolve broadcaster id + create all subscriptions via `EventSubSubscriber` POST /eventsub/subscriptions transport websocket+session_id; on reconnect do NOT re-subscribe), `session_keepalive` (reset timer), `session_reconnect` (connect new url, close old after 30s), `notification` (reset timer + dispatch), `revocation` (log). Timers: default keepalive 20s, reconnect delay 10s, stale-socket close 30s. **Generation guard**: an integer generation incremented on disconnect; every async continuation checks it before mutating state.

- [ ] Steps: failing tests feeding a fake socket canned frames: a `session_welcome` frame triggers subscription creation (assert the subscriber was called with all required types incl. the 5 chat/mod subs); a `session_keepalive` resets the watchdog; a `session_reconnect` connects the new url and schedules the old close; a stale-generation continuation does not mutate state after a disconnect. `EventSubSubscriptionsTests` asserts the exact type+version+condition set (regression against accidental drops). Implement. Green + build. Commit `feat: EventSub WebSocket source with subscription set and generation guard`.

### Task 6: EventSub dispatch → domain notifications + chat ingestion + roles

**Files:** `EventSub/EventSubDispatcher.cs`, `Chat/ChatMessageModels.cs`, `Chat/IChatRoleResolver.cs`, `Chat/ChatRoleResolver.cs`; and domain notification types (in `Narya.Application` or `Narya.Core` as `IRealtimeNotification`s where they broadcast) for `chat:message`, `chat:moderated`, `stream:event`, `stream:event:update`, `whisper:message`. Tests `EventSub/EventSubDispatcherTests.cs`, `Chat/ChatRoleResolverTests.cs`.

**Interfaces:**
- `ChatRoleResolver.Resolve(badges)` → `Role { Broadcaster, Moderator, Vip, Subscriber, Regular }` first-match priority (broadcaster>mod>vip>sub>regular), port of roles.ts; plus `ResolveAll(badges)` → the multi-role list for rosters.
- `EventSubDispatcher.Dispatch(subType, eventJson, messageId)` → maps each subscription type to a domain action per the legacy dispatch table (§5 of the spec): follow/sub/gift/cheer/raid/redeem/ad_break → `stream:event` (with the exact tone: follow=silver, sub=warning, gift=warning, cheer=info, raid=note, redeem=info, ad_break=info) and the sub-merge dedup (channel.subscribe vs channel.subscription.message within a 60s window → `stream:event:update`); `channel.update` → a category signal (a `CategorySignal` notification the Phase 8 category coordinator consumes — define the notification now, no-op handler until Phase 8); `stream.online`/`stream.offline` → stream-session notifications (define now; Phase 3 implements session tracking); `channel.chat.message` → a `ChatMessage` (id, channel, username lower, displayName, color, message, badges, emotes, timestamps) broadcast as `chat:message` + dispatched to automation (Phase 4 — define the hook now); `channel.chat.message_delete`/`channel.chat.clear`/`channel.chat.clear_user_messages`/`channel.moderate` → `ChatModerationEvent` (`message.deleted`/`chat.clear`/`user.timeout`/`user.ban`) broadcast `chat:moderated`; `user.whisper.message` → `whisper:message` (operator-only — NOT overlay-allowlisted); automod.message.hold/update → automod notifications (Phase 3 implements the hold queue; define now). Keep `channel.chat.notification` watch_streak → redeem stream event. Bot-loop guard (skip the bot's own chat login). `!tts` stays a Phase 4 concern (dispatcher just forwards chat to the automation hook).
- `chat:message`, `chat:moderated`, `stream:event`, `stream:event:update` are on the overlay allowlist (add to `RealtimeEventNames.OverlayAllowlist`); `whisper:message` is NOT.

- [ ] Steps: failing tests: given a canned `channel.follow` event → produces a `stream:event` with kind=follow tone=silver; a `channel.subscription.message` following a `channel.subscribe` within window → produces a `stream:event:update` not a second event; a `channel.chat.message` → a ChatMessage with lowercased username + parsed badges/roles; a `channel.chat.message_delete` → a `chat:moderated` message.deleted; a bot-login chat message is skipped; ChatRoleResolver priority order. Add the 4 overlay events to the allowlist and assert (a RealtimeRouting test) that `chat:message` routes to BOTH operator and overlay groups while `whisper:message` routes to operator only. Implement. Green + build. Commit `feat: EventSub dispatch to domain events + EventSub chat ingestion and role resolution`.

---

## Deferred to later phases (do NOT build in Phase 2)
- Persisting chat/events/sessions/automod holds and the session-scoping (Phase 3) — Phase 2 emits the notifications; Phase 3 adds handlers that persist + the mutable projections.
- Automation dispatch of chat commands / `!tts` (Phase 4).
- Category-module coordination consuming `channel.update` (Phase 8).
- Reward CRUD Helix endpoints (Phase 8).
- Live Twitch verification, EventSub webhook transport (needs public HTTPS) — operator-gated.

## Self-Review
- Coverage: OAuth (T2,T3), token store (T1), credentials/refresh/app-token (T2), Helix (T4), EventSub transport+subs+guard (T5), dispatch+chat+roles (T6). Scope lists verbatim (Global Constraints + T1). Chat-transport decision recorded. Secret-masking preserved (T3 status is booleans+expiry+missing-scope-names).
- Cross-task types: `TwitchProvider`, `TwitchToken`, `ITwitchTokenStore` (T1) → consumed by T2/T3/T4/T5; `ITwitchCredentials` (T2) → T4/T5; `ITwitchEventSource` (defined T3 stub, implemented T5); `IHelixClient.GetBroadcasterIdAsync` (T4) → used by T2/T5 credential/subscription flows; notification types (T6) reuse Phase 1 `IRealtimeNotification` + allowlist.
- Marten event registration across assemblies (T1 Step 3) is the one cross-cutting risk — the Twitch events live in a new assembly and must be registered with the same DocumentStore; the fix (multi-assembly scan) is called out explicitly.
