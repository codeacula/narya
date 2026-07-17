# TwitchLib Migration Reference (Narya Phase 2, Tasks 4–6)

> Implementation-grade spec produced by a verified research pass (context7 + web +
> live NuGet/GitHub source, adversarially fact-checked). This is the authoritative
> reference for wrapping TwitchLib in Narya's `IHelixClient` / `ITwitchEventSource`.
> **UNVERIFIED items (§5)** must be confirmed at build time against the pinned tags.

## 1. NuGet packages + net10 verdict — GREEN

Pin in `Directory.Packages.props`:
```xml
<PackageVersion Include="TwitchLib.Api" Version="3.10.2" />
<PackageVersion Include="TwitchLib.EventSub.Websockets" Version="0.8.0" />
<PackageVersion Include="TwitchLib.EventSub.Core" Version="3.0.0" />
```
- `TwitchLib.EventSub.Websockets 0.8.0` (2025-11-22): explicit **net10.0** TFM (+net8/net9/netstandard2.0/2.1); uses System.Text.Json; deps floor `Microsoft.Extensions.Logging.Abstractions ≥ 10.0.0` (in-box).
- `TwitchLib.EventSub.Core 3.0.0`: payload POCOs, transitive; pin to lock.
- `TwitchLib.Api 3.10.2` (2025-11-01): TFMs netstandard2.0/net8.0/net9.0 (NO explicit net10 — runs via the net9.0 asset, normal forward-compat). Uses **Newtonsoft.Json**, so the graph has both Newtonsoft (Api) + System.Text.Json (EventSub) — expected, not a conflict.
- **Build-time check:** `dotnet restore` + `dotnet build` on net10 must resolve Api's net9.0 asset + EventSub's net10.0 asset with no downgrade warnings.

## 2. Helix wrapper (`IHelixClient` → `HelixClient` → TwitchLib.Api)

### Construction (a single singleton `TwitchAPI`)
```csharp
var api = new TwitchAPI();
api.Settings.ClientId = clientId;                 // Client-Id header
// DO NOT set Settings.Secret  (would enable auto app-token minting)
api.Settings.SkipAutoServerTokenGeneration = true; // never mint app tokens
api.Settings.SkipDynamicScopeValidation   = true;  // don't pre-reject per-call tokens vs stale global Scopes
// Settings.AccessToken stays null — NEVER the authority.
```
Register `TwitchAPI` singleton + `HelixClient` singleton.

### Per-call token pattern (the core rule)
**Never mutate `Settings.AccessToken` on the hot path.** Every authenticated Helix
method has a trailing `string accessToken = null` that wins over settings and is
concurrency-safe. Resolve a fresh token from `ITwitchCredentials` per call:
```csharp
var token = await _credentials.GetAccessTokenAsync(TwitchProvider.Broadcaster, ct); // .Value
await _api.Helix.Channels.ModifyChannelInformationAsync(bid, req, accessToken: token);
```
`ApiBase.GetAccessTokenAsync` precedence: per-call arg > `Settings.AccessToken` >
auto-mint (dead with `Secret` unset). TwitchLib does **no** user-token refresh and
no per-request `/validate` — our store stays the single source of truth. Token TYPE
is Twitch-enforced: eventsub sub-creation + chat-send need a USER token (broadcaster
or bot) with the right scopes; chat-send `sender_id` must match the token's user.

### Method-mapping table (`api.Helix.<Category>.<Method>`; trailing `accessToken` omitted)
| Our op | TwitchLib call | Return | Failure surfacing |
|---|---|---|---|
| Resolve user | `Users.GetUsersAsync(ids, logins)` | `.Users[]` | empty array if none; no throw |
| Get channel info | `Channels.GetChannelInformationAsync(bid)` | `.Data[]` (GameId/GameName/Title/Tags) | — |
| Modify channel info | `Channels.ModifyChannelInformationAsync(bid, ModifyChannelInformationRequest)` | `Task<bool>` | failure THROWS (not false). `GameId=""/"0"` unsets; Tags string[] |
| Stream status | `Streams.GetStreamsAsync(userIds:[..])` | `.Streams[]` | **empty array = offline** (not 404) |
| Ad schedule | `Channels.GetAdScheduleAsync(bid)` | `.Data[]` (NextAdAt/Duration/SnoozeCount) | — |
| Start commercial | `Channels.StartCommercialAsync(StartCommercialRequest{BroadcasterId,Length})` | `.Data[]` (Length/Message/RetryAfter) | non-2xx throws |
| Search categories | `Search.SearchCategoriesAsync(query)` | `.Categories[]` (Id/Name/BoxArtUrl) | — |
| Games by id | `Games.GetGamesAsync(gameIds:[..])` | `.Games[]` | — |
| **Send chat** | **`Chat.SendChatMessage(SendChatMessageRequest{BroadcasterId,SenderId,Message,ReplyParentMessageId})`** — **NO `Async` suffix** | `.Data[]` (MessageId, IsSent, DropReason{Code,Message}) | **drop = HTTP 200 + IsSent=false + DropReason (does NOT throw)** — inspect IsSent, map DropReason → Result.Fail |
| Shoutout | `Chat.SendShoutoutAsync(from, to, moderatorId)` | Task | no throw on success |
| Whisper | `Whispers.SendWhisperAsync(from, to, msg, newRecipient)` | Task | needs user:manage:whispers |
| Ban+timeout | `Moderation.BanUserAsync(bid, moderatorId, BanUserRequest{UserId,Duration?,Reason})` | `BanUserResponse` | Duration 1..1209600 = timeout, null = ban |
| AutoMod allow/deny | `Moderation.ManageHeldAutoModMessagesAsync(userId, msgId, ManageHeldAutoModMessageActionEnum.ALLOW/DENY)` | Task | — |
| Create EventSub sub | `EventSub.CreateEventSubSubscriptionAsync(type, version, Dictionary<string,string> condition, EventSubTransportMethod.Websocket, websocketSessionId, ..., accessToken)` | `.Subscriptions[]` | wrong version/condition → Helix 400 throws — surface it |

### Error mapping → FluentResults
TwitchLib throws non-2xx (`TwitchLib.Api.Core.Exceptions`): 400 `BadRequestException`,
401 `TokenExpiredException`/`BadScopeException`, 403 `BadTokenException`, 404
`BadResourceException` (**404 throws**), 429 `TooManyRequestsException`,
5xx `InternalServerError/BadGateway/GatewayTimeoutException`. **422/unmapped escape
as plain `System.Net.Http.HttpRequestException`** — so catch broadly:
```csharp
try { return Result.Ok(await op(token)); }
catch (TooManyRequestsException ex) { /* Fail + backoff signal */ }
catch (TokenExpiredException or BadTokenException or BadScopeException) { /* Fail + re-auth signal */ }
catch (BadResourceException) { /* 404 → not-found Fail */ }
catch (Exception ex) { /* Fail(ex) — catches the 422 HttpRequestException */ }
```
Two NON-exception paths handled inside the wrapper: `SendChatMessage` `IsSent==false`
→ `Result.Fail(dropReason.Message)`; `GetStreamsAsync` empty → domain "offline".

### Caches + single-flight (OUR decorators, TwitchLib provides none)
- Stream-status cache 15s TTL; ad-schedule cache 5s TTL (keyed by broadcaster,
  `TimeProvider` for expiry). Cache successes only.
- Single-flight commercial: concurrent callers coalesce onto one in-flight Task
  (`SemaphoreSlim(1,1)` or shared-task latch). Honor `RetryAfter`.

## 3. EventSub (`ITwitchEventSource` wraps `EventSubWebsocketClient`)

### DI + lifetimes
```csharp
services.AddTwitchLibEventSubWebsockets();          // EventSubWebsocketClient = SINGLETON
services.AddHostedService<TwitchEventSubService>(); // our BackgroundService
```
Wire ALL handlers in the hosted-service ctor BEFORE ConnectAsync. Handlers are
`AsyncEventHandler<T>` = `async Task H(object? sender, TArgs e)`.

### Connect → subscribe flow
```
StartAsync         -> _ws.ConnectAsync()   (Task<bool>; default wss://eventsub.wss.twitch.tv/ws)
WebsocketConnected -> read _ws.SessionId; if (e.IsRequestedReconnect) return;
                      else CreateSubscriptionsAsync()  // Helix, FRESH broadcaster token per call
StopAsync          -> _ws.DisconnectAsync() (Task<bool>)
```

### DROP the hand-rolled generation guard — the library handles:
- keepalive-timeout detection (internal `ConnectionCheckAsync` → fires `WebsocketDisconnected`)
- Twitch `session_reconnect` (dual-connect to new URL, wait ~20s, atomic swap, dispose old). Subs carry over — do NOT re-subscribe (that's the `IsRequestedReconnect` guard).

### Our BackgroundService STILL owns:
1. **Reconnect after a hard drop.** `WebsocketDisconnected` → `_ws.ReconnectAsync()` in an **exponential-backoff loop** (NOT the README's tight `while(!ReconnectAsync()) Delay(1000)`).
2. **Re-subscribe only if `SessionId` changed** (hard drop = new session → recreate all subs; graceful migration reuses session).
3. Handle `Revocation` + `ErrorOccured` (library spelling — ONE "r").
4. **Never manual `DisconnectAsync()`+`ConnectAsync()` on the same instance** (issue #37 "WebSocket has already been started") — always `ReconnectAsync()` (resolves a fresh `WebsocketClient` from DI).

### Required subscriptions (all strongly-typed events; none fall through to `UnknownEventSubNotification`)
Version/condition are Helix-call args (our responsibility):
- `channel.chat.message` **v1**, cond `broadcaster_user_id`+`user_id`, scope `user:read:chat`
- `channel.chat.message_delete` v1, `channel.chat.clear` v1, `channel.chat.clear_user_messages` v1
- `channel.moderate` **v1 and v2** exist (`ChannelModerate`/`ChannelModerateV2`) — pick the version you subscribe with
- `channel.update` **v2**; `stream.online`/`stream.offline` v1
- `channel.follow` **v2**, cond `broadcaster_user_id`+`moderator_user_id`, scope `moderator:read:followers`
- `channel.subscribe` v1, `channel.subscription.message` v1, `channel.subscription.gift` v1, `channel.cheer` v1, `channel.raid` v1 (`to_broadcaster_user_id`/`from_broadcaster_user_id`)
- `channel.channel_points_custom_reward_redemption.add` v1
- `automod.message.hold`/`automod.message.update` v1 and v2 (`...V2Args`), cond `broadcaster_user_id`+`moderator_user_id` (moderator must equal token user), scope `moderator:manage:automod`
- optional: `channel.ad_break.begin` v1, `user.whisper.message` v1

### Event → domain-event dispatch
- `ChannelChatMessage` → ChatMessage (MessageId, ChatterUserId/Login/Name, Color, Badges, Message.Text/Fragments, IsBroadcaster/Moderator/Subscriber/Vip) → `chat:message`
- `channel.chat.message_delete`/`clear`/`clear_user_messages` → `chat:moderated`
- `ChannelModerateV2` → moderation audit (ban/timeout/delete)
- `ChannelUpdate`/`stream.online`/`stream.offline` → category signal / session (Phase 3/8)
- `ChannelPointsCustomRewardRedemptionAdd` → reward trigger (dedup on redemption id)
- subscribe/sub.message/gift/cheer/raid/follow → twitch_event triggers (Phase 4)
- `automod.message.hold/update` → held queue (Phase 3)
- `user.whisper.message` → `whisper:message` (operator-only, NOT overlay-allowlisted)

**Dedup:** the WS lib surfaces the PAYLOAD, not Twitch's transport message-id header.
Key `automation_runs` dedup off the DOMAIN event id (redemption id, chat MessageId).
`session_reconnect` does NOT replay; a hard reconnect recreating subs could re-deliver
recent events — absorbed by the source-event-id partial-unique index.

## 4. Testing strategy (test at OUR seams — the real socket is un-fakeable)
- **Dispatcher as a pure function (highest value):** `EventSub.Core` payloads are public POCOs — construct `*Args`/`e.Payload.Event` in-memory from canned payloads, call the handler, assert the emitted domain event. Regression-locks chat-field mapping, moderated→soft-delete, channel.update→category (incl. null-category vs lookup-failure), redemption→trigger + dedup key. Keep the dispatcher a pure translation (no I/O).
- **Subscription-creation contract:** behind `ITwitchEventSource`, assert connect drives the correct `(type, version, condition)` tuples (locks the v2/condition/scope gotchas, e.g. follow "2" with moderator_user_id).
- **Helix wrapper at the `IHelixClient` seam:** fake TwitchLib at our seam and test our decorators — 15s/5s cache TTLs (hit → no second delegate call; expiry → refresh), single-flight commercial (N concurrent → 1 delegate call), error mapping (TokenExpired→refresh-Fail, TooManyRequests→backoff-Fail, raw HttpRequestException(422)→generic Fail, SendChatMessage IsSent=false→Fail(drop), GetStreams empty→offline).
- **Reconnect/keepalive (integration only):** Twitch CLI mock EventSub server (`twitch event websocket`) smoke test — out of scope for unit tests.

## 5. Prioritized gotchas + UNVERIFIED (confirm at build time)
Gotchas: (1) EventSub.Websockets only RECEIVES — all sub-creation is Helix inside `WebsocketConnected`; (2) guard sub-creation with `IsRequestedReconnect`; (3) `SendChatMessage` no `Async`, drop=200+IsSent=false; (4) 422 = `HttpRequestException`; (5) 404 throws, offline=empty array; (6) never manual Disconnect+Connect (#37); (7) `SkipDynamicScopeValidation=true` mandatory with per-call tokens; (8) don't set `Settings.Secret`; (9) Newtonsoft+STJ coexist (fine); (10) "Failed Ping/Pong" spurious disconnects (#48) — robust backoff; (11) very-new sub types may lag in Core.
UNVERIFIED — implementer confirms: restore resolves net9 Api asset + net10 EventSub asset no-downgrade; per-call `accessToken` param exists on the **3.10.2 tag** for every method we call (added incrementally, confirmed on master); `automod.message.hold` version string modeled by Core 3.0.0; exact `ApiSettings` property spellings (`SkipAutoServerTokenGeneration`, `SkipDynamicScopeValidation`, `Secret`, `Scopes`) on 3.10.2; issues #37/#48 still open.
