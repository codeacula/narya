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

> **Tasks 4–6 REVISED (2026-07-17): use TwitchLib.** Per the operator's decision, the C#
> backend talks to Twitch via **TwitchLib.Api** (Helix) + **TwitchLib.EventSub.Websockets**
> (socket). We keep our own `IHelixClient`/`ITwitchEventSource` interfaces, token store/refresh,
> caches, single-flight, FluentResults mapping, and Narya-specific dispatch/dedup **on top**.
> The authoritative implementation reference (packages, per-call token pattern, method/event
> mapping, gotchas, UNVERIFIED build-time checks) is
> **`docs/superpowers/references/twitchlib-spec.md`** — implementers and reviewers read it.

### Task 4: Helix client (TwitchLib.Api wrapper) + response caches

**Files:** `Helix/IHelixClient.cs`, `Helix/HelixClient.cs`, `Helix/HelixModels.cs` (our own result records — do NOT leak TwitchLib response types across `IHelixClient`), `Helix/HelixCaches.cs`; add TwitchLib.Api to `Directory.Packages.props` + `Narya.Twitch.csproj`; tests `Helix/HelixClientTests.cs`.

**Approach:** `HelixClient` composes a singleton `TwitchAPI` (ClientId set, Secret UNSET, `SkipAutoServerTokenGeneration=true`, `SkipDynamicScopeValidation=true`, AccessToken null) and delegates, resolving a fresh token from `ITwitchCredentials` and passing it as the trailing per-call `accessToken` arg (never mutate `Settings.AccessToken`). See twitchlib-spec §2 for the method-mapping table and error mapping.

**`IHelixClient` methods** (our interface; each returns `Result<T>` over OUR record types, not TwitchLib types) — FULL Twitch-core set:
- `GetAuthenticatedUserAsync(TwitchProvider)` → `{Id, Login}`; `GetBroadcasterIdAsync()` (cached, implements `IBroadcasterIdResolver` — closes the Task 2 gap); `ResolveUserIdAsync(login)` (404/`BadResourceException` → Fail "not found").
- `GetChannelInfoAsync()` → `{BroadcasterName, GameId, GameName, Title, Tags[]}`; `UpdateChannelInfoAsync(title, gameId, tags[])` (`ModifyChannelInformationAsync`; failure THROWS → map to Fail).
- `GetStreamStatusAsync()` → `{StartedAt?, ViewerCount?}` (**15s cache**; empty array = offline, not a failure).
- `GetAdScheduleAsync()` → ad fields (**5s cache**, scope `channel:read:ads`).
- `SearchCategoriesAsync(query)`, `GetGameByIdAsync(id)`.
- `RunCommercialAsync(lengthSeconds=180)` (**single-flight** coalesce).
- `SendChatMessageAsync(sender: Broadcaster|Bot, message, replyParentMessageId?)` — **`Chat.SendChatMessage` (NO Async suffix)**; a drop is **HTTP 200 with `IsSent=false` + `DropReason`** (does NOT throw) → map `DropReason` to `Result.Fail`.
- `SendShoutoutAsync(toBroadcasterId)`, `SendWhisperAsync(toUserId, message)` (500-char cap), `BanOrTimeoutAsync(userId, duration?, reason?)` (`BanUserAsync`; duration 1..1209600 = timeout, null = ban), `ResolveAutomodMessageAsync(msgId, allow|deny)`.
- **DEFER to their consuming phases:** chatters/VIPs/mods/followers/subs lookups (Phase 3 viewers); reward CRUD (Phase 8). Leave a comment marking where.

**Error mapping → FluentResults** (twitchlib-spec §2.4): broad catch — `TooManyRequestsException`→backoff-Fail, `TokenExpired/BadToken/BadScopeException`→re-auth-Fail, `BadResourceException`→not-found-Fail, then `catch(Exception)` (catches the 422 `HttpRequestException`). Non-exception paths: `SendChatMessage IsSent=false`→Fail(drop); `GetStreams` empty→offline.

- [ ] Steps: BUILD-TIME FIRST — add the packages, `dotnet restore`+`build`, confirm net10 resolves Api's net9 asset with no downgrade warnings and the `ApiSettings` property names + per-call `accessToken` params exist on the 3.10.2 tag (twitchlib-spec §5 UNVERIFIED). Then failing tests at the `IHelixClient` seam: substitute the TwitchLib delegate (wrap the `api.Helix.*` calls behind a tiny internal seam you can fake, OR inject a fake `ITwitchAPI`) — assert the 15s/5s cache TTLs (hit → no second delegate call; expiry via injected clock → refresh), single-flight commercial (N concurrent → 1 delegate call), `SendChatMessage IsSent=false`→Fail, `TokenExpiredException`→re-auth-Fail, offline empty→offline. Register `IHelixClient→HelixClient` + `IBroadcasterIdResolver→` same instance in `AddNaryaTwitch` (closes the Task 2 DI gap). Green + full-suite build. Commit `feat: Twitch Helix client over TwitchLib.Api with stream/ad caches`.

### Task 5: EventSub source (TwitchLib.EventSub.Websockets wrapper) + subscription creation

**Files:** `EventSub/ITwitchEventSource.cs` (already stubbed in Task 3 — implement it), `EventSub/TwitchEventSubService.cs` (the `BackgroundService`), `EventSub/EventSubSubscriptions.cs` (the type+version+condition table), `EventSub/EventSubStatus.cs`; add TwitchLib.EventSub.Websockets (+ .Core) to CPM + csproj; tests `EventSub/EventSubSubscriptionsTests.cs`.

**Approach (twitchlib-spec §3):** `TwitchEventSubService : BackgroundService` wraps the singleton `EventSubWebsocketClient` (registered via `AddTwitchLibEventSubWebsockets()`), wires all handlers in its ctor before `ConnectAsync`, and on `WebsocketConnected` (when `!e.IsRequestedReconnect`) creates every subscription via `IHelixClient`/`api.Helix.EventSub.CreateEventSubSubscriptionAsync(type, version, condition, EventSubTransportMethod.Websocket, SessionId, accessToken: <fresh broadcaster token>)`. **DROP the hand-rolled generation guard** — TwitchLib owns keepalive + `session_reconnect`. The service STILL owns: hard-drop reconnect on `WebsocketDisconnected` via `ReconnectAsync()` in an **exponential-backoff loop** (NEVER manual Disconnect+Connect — issue #37), re-subscribe only if `SessionId` changed, handle `Revocation` + `ErrorOccured` (one "r"). Guarded by `SkipInfrastructure` so WAF tests don't open a socket.

- `ITwitchEventSource` (from Task 3): implement `StartAsync`/`StopAsync`/`ReconnectAsync` delegating to the client. The Task 3 `NoopTwitchEventSource` is REPLACED (register the real one with `AddSingleton`/`Replace`, but keep Noop available for SkipInfrastructure tests).
- `EventSubSubscriptions.All` = the type+version+condition table (twitchlib-spec §3.4): `stream.online`/`stream.offline` v1, `channel.update` v2, `channel.follow` v2 (`broadcaster_user_id`+`moderator_user_id`), `channel.subscribe`/`subscription.message`/`subscription.gift`/`cheer`/`raid` v1, `channel.chat.notification` v1, `channel.chat.message` v1 (`broadcaster_user_id`+`user_id`), `channel.chat.message_delete`/`chat.clear`/`chat.clear_user_messages` v1, `channel.moderate` (v1 or v2 — pick the version whose typed handler exists in Core 3.0.0), `automod.message.hold`/`automod.message.update` (v1 or v2 — confirm typed handler), plus optional `channel.channel_points_custom_reward_redemption.add` v1, `channel.ad_break.begin` v1, `user.whisper.message` v1.

- [ ] Steps: `EventSubSubscriptionsTests` asserts the exact `(type, version, condition)` tuples for the full set (regression-locks the v2/condition gotchas — e.g. follow "2" carries `moderator_user_id`). The socket lifecycle itself (connect/reconnect/keepalive) is TwitchLib-owned and only smoke-tested via the Twitch CLI mock server (out of unit scope — note it, don't build it now). Wire DI + hosted service under the infra guard. Build (confirm the typed handlers for the versions you chose actually exist in Core 3.0.0). Commit `feat: EventSub source over TwitchLib.EventSub.Websockets with subscription set`.

### Task 6: EventSub dispatch (pure fn) → domain notifications + chat + roles

**Files:** `EventSub/EventSubDispatcher.cs` (a PURE translation: TwitchLib `*Args`/payload POCO → our domain notification, NO I/O), wired into `TwitchEventSubService`'s handlers; `Chat/ChatMessageModels.cs`, `Chat/IChatRoleResolver.cs`, `Chat/ChatRoleResolver.cs`; domain `IRealtimeNotification`s for `chat:message`, `chat:moderated`, `stream:event`, `stream:event:update`, `whisper:message`. Tests `EventSub/EventSubDispatcherTests.cs`, `Chat/ChatRoleResolverTests.cs`.

**Approach (twitchlib-spec §3.5, §4):** the dispatcher is a pure function so it's testable without a socket — construct the TwitchLib `*Args`/`e.Payload.Event` POCOs (they're public in `EventSub.Core`) from canned payloads and assert the emitted domain event.
- `ChatRoleResolver.Resolve(badges)` → `Role {Broadcaster,Moderator,Vip,Subscriber,Regular}` first-match priority (broadcaster>mod>vip>sub>regular); `ResolveAll(badges)` → multi-role list. (For `channel.chat.message`, TwitchLib gives `IsBroadcaster/Moderator/Subscriber/Vip` flags directly — resolve from those + badges.)
- Dispatch mapping: follow/sub/gift/cheer/raid/redeem/ad_break → `stream:event` (tones: follow=silver, sub=warning, gift=warning, cheer=info, raid=note, redeem=info, ad_break=info) + sub-merge dedup (subscribe vs subscription.message within 60s → `stream:event:update`); `ChannelChatMessage` → `ChatMessage` (MessageId, lower login, displayName, color, badges, message text) → `chat:message`; `channel.chat.message_delete`/`chat.clear`/`chat.clear_user_messages`/`channel.moderate` → `ChatModerationEvent` → `chat:moderated`; `user.whisper.message` → `whisper:message` (operator-only); `channel.update`→category signal (define notification, Phase 8 consumes); `stream.online/offline`→session notifications (Phase 3); automod.hold/update→automod notifications (Phase 3); redemption dedup keys off the **redemption id** (not a transport id). Bot-loop guard (skip the bot's own chat login). `!tts`/automation forwarding is a Phase 4 hook (define the seam).
- `chat:message`, `chat:moderated`, `stream:event`, `stream:event:update` → add to `RealtimeEventNames.OverlayAllowlist`; `whisper:message` NOT.

- [ ] Steps: failing pure-function tests: canned `ChannelChatMessage` args → `ChatMessage` with lowercased login + roles from flags; `channel.follow` → `stream:event` kind=follow tone=silver; a `subscription.message` after `subscribe` within window → `stream:event:update` not a second event; `channel.chat.message_delete` → `chat:moderated` message.deleted; a bot-login chat message skipped; ChatRoleResolver priority. Add the 4 events to `OverlayAllowlist` + a RealtimeRouting test asserting `chat:message` routes to operator+overlay and `whisper:message` to operator only. Implement. Green + build. Commit `feat: EventSub dispatch to domain events + chat ingestion and role resolution`.

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
