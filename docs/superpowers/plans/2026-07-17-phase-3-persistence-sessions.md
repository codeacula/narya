# Phase 3: Chat/Event Persistence, Sessions, Viewers, AutoMod Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** Persist the domain events Phase 2 emits — chat (dual-layer append-only + mutable soft-delete projection), stream events (session-stamped), stream sessions (online/offline-driven), chatters, viewer profiles, and the AutoMod hold queue — plus the read APIs the dashboard/overlays consume (recent chat, events, viewers roster, session shoutouts, dashboard status heartbeat). Implements the **ingested→enrich→broadcast** notification split deferred from Phase 2.

**Architecture:** Marten documents (not event-sourced aggregates) for the append-mostly telemetry and mutable projections, updated by MediatR handlers reacting to Phase 2's Twitch notifications. `chat_events`/`stream_session_chatters` are append-only; `chat_messages`/`chatters`/`stream_sessions`/`automod_holds`/`viewer_profiles` are mutable projections. Read APIs are MediatR queries over Marten. Realtime broadcasts go through the Phase 1 `IRealtimePublisher` bridge; operator-only events (automod, dashboard status) are NOT overlay-allowlisted.

**Tech Stack:** .NET 10, Marten (documents + LINQ queries), MediatR 13, FluentResults, Testcontainers Postgres, NSubstitute.

## Global Constraints
- MediatR 13 pinned; net10.0; no inline package versions (CPM); FluentResults for expected failures, no blanket catch→Fail.
- **Marten dedup = insert-or-ignore on a natural id.** `session.Store` upserts (overwrites); to match legacy `insert or ignore` (first write wins, redelivery is a no-op), a handler must load-check-then-insert (or `session.Insert` + catch the PK conflict). The chatters increment + the broadcast fire ONLY on a genuinely new row.
- Two business-logic idempotency rules to preserve EXACTLY: **automod authoritative-override** (a resolved hold is immutable except an authoritative verdict may overturn a speculative `expired`), and the **sub-merge 60s window** (already in Phase 2's `TwitchEventSubService`).
- Timestamps stored as `DateTimeOffset` (UTC); the wire/JSON shape must match the legacy ISO-string payloads the client expects (`ChatMessage`, `StreamEvent`, `AutomodHold`, etc. — mirror the shapes in `legacy/src/shared/api.ts`).
- Realtime allowlist: `chat:message`/`chat:moderated`/`stream:event`/`stream:event:update`/`status:updated` overlay-visible; `automod:held`/`automod:resolved`/`dashboard:status`/`whisper:message` operator-only.
- Commit `feat:`/`fix:`/`test:` + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer. Build 0/0; full `dotnet test Narya.sln` green.
- **Read the legacy files for exact SQL/shapes** — the persistence exploration is the spec; `legacy/src/server/{chat,streamSession,automod,dashboard/status}.ts` + `db.ts` + `legacy/src/shared/api.ts` are authoritative.

## Where persistence lives
New project `Narya.Persistence`? — NO. Put the documents + Marten registration in `Narya.Database` (alongside DbAppConfig), the MediatR handlers + queries in `Narya.Application`, the read routes in `Narya.Api`. Domain records (ChatMessage, StreamEvent, AutomodHold, ViewerProfile, SessionShoutout, DashboardStatus) go in `Narya.Core` (they're shared contracts). The Phase 2 Twitch notifications move/adjust as needed (ingested vs broadcast split).

## The notification split (Phase 2 → Phase 3 restructure)
Phase 2 publishes `ChatMessageReceivedNotification`/`StreamEventOccurredNotification` as `IRealtimeNotification` (broadcast immediately, un-enriched). Phase 3 changes this to **enrich-before-broadcast**:
- The EventSub dispatcher/service publishes an **ingested** notification: `ChatMessageIngestedNotification : INotification` (NOT IRealtimeNotification — carries the raw dispatched ChatMessage) and `StreamEventIngestedNotification : INotification` (raw StreamEvent, no session id).
- A Phase 3 handler persists + enriches (first-timer flags, session id) then publishes the **broadcast** notification: `ChatMessageBroadcastNotification : INotification, IRealtimeNotification` (EventName `chat:message`, payload = the ENRICHED ChatMessage) and `StreamEventBroadcastNotification : INotification, IRealtimeNotification` (EventName `stream:event`, payload = the session-stamped StreamEvent). The Phase 1 bridge broadcasts the enriched payload.
- `whisper:message` stays a direct broadcast (no enrichment/persistence needed for Phase 3 — legacy doesn't persist whispers). Keep it as-is.

---

### Task 1: Chat persistence (dual-layer) + the ingested→broadcast split + first-timer/session enrichment

**Files:** `Narya.Database`: `Chat/ChatEventDocument.cs` (append-only), `Chat/ChatMessageDocument.cs` (mutable projection), `Chat/IChatStore.cs`+`ChatStore.cs`; `Narya.Core`: adjust `ChatMessage` record (add `IsFirstTimer`/`IsFirstThisSession`/`IsFirstEver`/`SessionId` — already has `ChatterUserId` from Phase 2 fix); `Narya.Twitch`: change `ChatMessageReceivedNotification`→`ChatMessageIngestedNotification` (strip IRealtimeNotification); `Narya.Application`: `Chat/ChatMessageBroadcastNotification.cs`, `Chat/PersistChatMessageHandler.cs` (INotificationHandler<ChatMessageIngestedNotification>); `Narya.Api`: chat read routes. Tests in each.

**Interfaces / behavior (legacy `chat.ts`):**
- `ChatEventDocument` = append-only: `Id`(guid), `Type`("message.created"|"message.deleted"|"user.timeout"|"user.ban"|"chat.clear"|"automod.hold"|"automod.resolve"), `Channel`, `MessageId?`, `Username?`, `PayloadJson`, `OccurredAt`. Plain insert (never dedup).
- `ChatMessageDocument` = mutable projection: `Id`(the Twitch message id — natural key), `Channel`, `Username`(lowercased), `DisplayName`, `Color?`, `Message`, `ReceivedAt`, `DeletedAt?`, `DeletedReason?`, `ModerationEventId?`, `BadgesJson?`, `EmotesJson?`, `StreamSessionId?`, `IsFirstInSession`, `IsFirstEver`, `ChatterUserId`.
- `PersistChatMessageHandler` on `ChatMessageIngestedNotification`: (1) append a `message.created` ChatEventDocument; (2) **insert-or-ignore** the ChatMessageDocument keyed by message id — if it already exists, STOP (redelivery, no double count/broadcast); (3) on genuine insert compute enrichment: `IsFirstEver = !isChannelOwner && !hasSeenChatterBefore(username)` (check the chatters store BEFORE the upsert), `SessionId` + `IsFirstInSession` via the session store (Task 3 — `RecordCurrentSessionChatter(login, messageId, occurredAt)`: insert-or-ignore into stream_session_chatters, changes>0 ⇒ first-in-session; the broadcaster is excluded from session-chatter tracking but still stamped with the live session id, IsFirstInSession=false); (4) upsert the chatters document (message_count+1, first_seen watermark preserved) ONLY on genuine insert; (5) publish `ChatMessageBroadcastNotification` with the ENRICHED ChatMessage → bridge broadcasts `chat:message`. Bot-loop guard already applied upstream (dispatcher skips the bot's own messages). NOTE: Task 3 provides the session store; if Task 3 isn't done yet in dispatch order, this task defines `ISessionStore` minimally (a stub returning null session) and Task 3 implements it — but session enrichment is load-bearing, so prefer sequencing Task 3's session store before this OR define the interface here and implement in Task 3, wiring the handler to it.
- Read routes (`Narya.Api`): `GET /api/chat/recent` → 40 most-recent `chat_messages` ordered received_at desc, reversed to oldest→newest, mapped to `ChatMessage` (parse badges/emotes JSON; note this route omits sessionId per legacy). `GET /api/chat/events/recent` → 100 most-recent chat_events reversed. Overlay-allowlisted (`/api/chat/recent` is; add to the middleware OverlayPaths — it's already in the legacy allowlist).

- [ ] Steps: failing Testcontainers tests (persist a ChatMessageIngested → a chat_message row + chat_event row + chatters upsert + a ChatMessageBroadcast published with IsFirstEver=true on first message; a redelivered same-id ingested → no second row, no second broadcast, no chatters double-count; the enrichment fields set). Read routes tested via WAF (SkipInfrastructure won't have Marten — use a substituted IChatStore, OR a Testcontainers integration test for the route; prefer substituting the query handler). Implement. Green + build. Commit `feat: chat dual-layer persistence with ingested→broadcast enrichment`.

### Task 2: Chat moderation persistence (soft-delete)

**Files:** `Narya.Twitch`: `ChatModeratedNotification`→ ingested variant if needed; `Narya.Application`: `Chat/PersistChatModerationHandler.cs`; extend `IChatStore`/`ChatStore` with the soft-delete ops. Tests.

**Behavior (legacy chat.ts soft-deletes):** on a `ChatModerated` (from Phase 2's dispatch of message_delete/clear/clear_user_messages), the handler: appends a chat_event of the matching type, then applies the soft-delete to chat_messages, linking `ModerationEventId` = the chat_event id and `DeletedAt` = the event's occurredAt, then broadcasts `chat:moderated`:
- `message.deleted` (single id): mark that one message deleted, reason `"message deleted by moderator"`.
- `user.timeout`: mark ALL of that user's currently-undeleted messages in the channel, reason `"timeout: {reason||'no reason provided'}"`.
- `user.ban`: same by-user scope, reason `"ban: {reason||'no reason provided'}"`.
- `chat.clear`: mark EVERY undeleted message in the channel, reason `"chat cleared"`.
(Note: Phase 2 maps `channel.chat.clear_user_messages`→user.timeout — a Phase-2 approximation; the ban/timeout distinction + reason needs channel.moderate which was dropped. For Phase 3, honor the type the notification carries.) The by-user/by-channel updates filter `DeletedAt is null` (idempotent re-run); single-id has no such guard (matches legacy).

- [ ] Steps: failing tests (a message.deleted marks one row + links moderation_event_id; a user.timeout marks all that user's undeleted rows; a chat.clear marks all; a re-delivered timeout only touches still-undeleted rows; each broadcasts chat:moderated). Implement. Green + build. Commit `feat: chat moderation soft-delete persistence`.

### Task 3: Stream sessions (online/offline-driven) + session-chatter tracking

**Files:** `Narya.Database`: `Sessions/StreamSessionDocument.cs`, `Sessions/StreamSessionChatterDocument.cs`, `Sessions/IStreamSessionStore.cs`+`StreamSessionStore.cs`; `Narya.Application`: handlers on `StreamOnlineNotification`/`StreamOfflineNotification` (Phase 2's deferred notifications). Tests.

**Behavior (legacy streamSession.ts):**
- `StreamSessionDocument`: Id(guid), StartedAt, EndedAt?, Source(natural key `twitch:{streamId}`), Discord fields (DiscordMessageId?/DiscordChannelId?/DiscordAnnounceError?/DiscordAnnounceAttempts/DiscordAnnounceTerminal — columns present; the announce flow is Phase 8).
- `IStreamSessionStore`: `GetActiveSessionAsync()` (EndedAt==null, newest); `GetCurrentSessionIdAsync()`; `GetOrStartSessionAsync(source, startedAt)` — dedup on Source (return existing if found, idempotent for a restarted stream.online); else in a transaction: close any open session (set EndedAt) THEN insert the new one (enforces "at most one active"); `EndActiveSessionAsync(endedAt)` (close all open); `RecordCurrentSessionChatterAsync(login, messageId, occurredAt)` → StreamSessionChatterDocument insert-or-ignore keyed `{sessionId}:{login}`, returns {SessionId, IsFirstInSession=inserted}; `GetSessionChatterCountAsync()`.
- Handlers: `StreamOnlineNotification` → `GetOrStartSessionAsync("twitch:"+streamId, startedAt)` (note: legacy starts the session inside the go-live announce task — for Phase 3, start it directly from the online notification; Phase 8's go-live announce attaches discord ids to the existing session). `StreamOfflineNotification` → `EndActiveSessionAsync()`.
- **DEVIATION from roadmap (documented):** StreamSession is a Marten DOCUMENT, not an event-sourced aggregate — its access is query-heavy ("find active", dedup on source, force-close-open) and its transitions are few; event-sourcing adds complexity without benefit here.

- [ ] Steps: failing Testcontainers tests (GetOrStart creates + is idempotent on same source; starting a new source closes the prior open session; only one active at a time; EndActive closes; RecordCurrentSessionChatter first call returns IsFirstInSession=true, second false; count). Wire the StreamOnline/Offline handlers. Implement. Green + build. Commit `feat: stream session tracking with one-active invariant and session-chatter first-seen`.

### Task 4: Stream event persistence + session stamping + the sub-merge update

**Files:** `Narya.Database`: `Events/StreamEventDocument.cs`, extend a store; `Narya.Twitch`: `StreamEventOccurredNotification`→ ingested split; `Narya.Application`: `Events/PersistStreamEventHandler.cs` (stamps session id + persists + publishes broadcast), `Events/UpdateStreamEventHandler.cs` (on StreamEventUpdated → update the stored row's detail/tone + broadcast). `Narya.Api`: `GET /api/dashboard/events`. Tests.

**Behavior (legacy eventsub.ts emit/update):** `StreamEventDocument`: Id, Kind, Actor, Detail, Tone, ReceivedAt, SessionId?, ActorLogin?. On `StreamEventIngestedNotification`: stamp `SessionId = GetCurrentSessionIdAsync()`, `ActorLogin = login?.ToLower()`, insert-or-ignore, publish `StreamEventBroadcastNotification` (EventName `stream:event`, payload StreamEvent with `ago:"just now"`). On `StreamEventUpdatedNotification` (the resub-merge from Phase 2): update the stored row's Detail/Tone, broadcast `stream:event:update`. `GET /api/dashboard/events` → 50 most-recent stream_events desc, mapped with `ago = formatAgo(receivedAt)` (no session filter in SQL — client dims). Operator-only route (dashboard).

- [ ] Steps: failing tests (ingested → stored with the current session id + broadcast; update → row updated + broadcast; events route returns recent with ago). Implement. Green + build. Commit `feat: stream event persistence with session stamping`.

### Task 5: Chatters store, viewer profiles, roster + recent-viewer projections

**Files:** `Narya.Database`: `Viewers/ChatterDocument.cs` (from Task 1), `Viewers/ViewerProfileDocument.cs`, `Viewers/IViewerStore.cs`+`ViewerStore.cs`; `Narya.Core`: ViewerProfile/Viewer/ViewerRosterEntry records; `Narya.Application`: profile-update command + roster/viewers queries; `Narya.Api`: routes. Tests.

**Behavior (legacy status.ts):**
- `ViewerProfileDocument`: Login(PK), RealName(""), TagsJson("[]"), Note(""), CreatedAt, UpdatedAt. `PATCH /api/dashboard/viewers/:login/profile` — normalize (realName≤120, note≤1000, tags≤12 each≤32, case-insensitive dedup keep-first-casing, non-string→400); upsert. **FIX the legacy bug: preserve CreatedAt on update** (only set UpdatedAt=now on the update branch).
- `GET /api/viewers/roster` — full roster: every chatters row left-joined to its single most-recent chat_message (Marten: query chatters, then for each the latest message — or a projection; the legacy uses a window function `row_number() partition by username order by received_at desc`, in Marten do a per-login latest-message lookup or a precomputed "last message" field on the chatter doc — cleanest: maintain `LastSeenAt`/`LastDisplay`/`LastColor`/`LastBadgesJson` on ChatterDocument, updated by the chat persistence handler, so the roster is a single chatters scan). Merge notes from viewer_profiles. Map to ViewerRosterEntry (login, display, color(fallbackColor hash), roles(from badges), messageCount, firstSeenAt, lastSeenAt, note).
- `GET /api/dashboard/viewers` — recent-activity projection keyed by login over the last 500 messages (display/color/roles/subbed-from-badge + up to 5 recent messages per viewer). `GET /api/viewers/:login/messages` — keyset pagination (received_at,id) < anchor, where username=login, 80/page, reversed.
- **Design note:** maintaining last-message fields on ChatterDocument (updated in the Task 1 handler) avoids the window-function join — reconcile Task 1 to also update these fields. If you take that approach, add it to Task 1's handler (or a small extension here).

- [ ] Steps: failing tests (profile upsert normalizes + preserves CreatedAt on update; roster lists all chatters with last-seen; viewers projection groups recent; per-viewer messages keyset-paginate and don't leak other users). Implement. Green + build. Commit `feat: viewer profiles, roster, and recent-viewer projections`.

### Task 6: AutoMod hold queue (persist + resolve + routes)

**Files:** `Narya.Database`: `Automod/AutomodHoldDocument.cs`, `Automod/IAutomodStore.cs`+`AutomodStore.cs`; `Narya.Twitch`: the deferred `AutomodHeldNotification`/`AutomodResolvedNotification` (from Phase 2 dispatch of automod.message.hold/update); `Narya.Application`: handlers + queue query + allow/deny commands; `Narya.Api`: routes. Tests.

**Behavior (legacy automod.ts):**
- `AutomodHoldDocument`: Id(Twitch message_id — natural key), Channel, Username, DisplayName, Message, Category?, Level?, HeldAt, ResolvedAt?, Resolution?("allowed"|"denied"|"expired"), ResolvedBy?.
- `RecordAutomodHoldAsync` (on AutomodHeldNotification): insert-or-ignore on id; on genuine insert append a `automod.hold` chat_event + broadcast `automod:held`.
- `ResolveAutomodHoldAsync(id, resolution, resolvedBy, authoritative)`: the THREE-WAY idempotency — if already resolved, return unchanged UNLESS `authoritative && existing==expired && new!=expired` (overturn the speculative expire once); on change, update + append `automod.resolve` chat_event + broadcast `automod:resolved`. On AutomodResolvedNotification (from Twitch automod.message.update, authoritative) → resolve authoritative.
- `SweepExpiredHoldsAsync()`: unresolved holds with HeldAt < now-2h → resolve `expired` (non-authoritative). Called at the top of `GetQueueAsync`.
- `GetQueueAsync` → `GET /api/automod/queue` → `{ pending, recentlyResolved }`: pending = 200 newest unresolved re-sorted oldest-first; recentlyResolved = resolved within 15min, 20 max, newest-first.
- `POST /api/automod/:id/allow` + `/deny` → look up local hold (404 if unknown); if already resolved, return idempotently; else `IHelixClient.ResolveAutomodMessageAsync(id, allow|deny)` (Phase 2) → 404/gone → resolve local `expired`; else resolve authoritative with the moderator login. All operator-only. `automod:held`/`automod:resolved` NOT overlay-allowlisted.

- [ ] Steps: failing tests (record → held broadcast + insert-or-ignore; the 3-way idempotency: unresolved→resolve, resolved+non-authoritative→no-op, resolved-expired+authoritative→overwrite once; sweep expires old; queue shape; allow/deny via substituted IHelixClient → 404-gone→expired vs ok→authoritative). Implement. Green + build. Commit `feat: AutoMod hold queue persistence, resolution, and routes`.

### Task 7: Session shoutouts + dashboard status heartbeat

**Files:** `Narya.Application`: `Dashboard/GetSessionShoutoutsQuery.cs`, `Dashboard/GetDashboardStatusQuery.cs`, `Dashboard/DashboardHeartbeatService.cs` (BackgroundService); `Narya.Core`: SessionShoutout + DashboardStatus records; `Narya.Api`: routes. Tests.

**Behavior (legacy status.ts):**
- `GET /api/dashboard/session-shoutouts` → current session's stream_events where kind in THANK_WORTHY (`follow,sub,gift,cheer,raid,redeem` — NO ad_break), ordered received_at asc, grouped per actor (key = login ?? actor.lower): kinds = dedup'd ordered list, detail = most-recent event's detail, firstAt/lastAt tracked, login backfilled from a later row. Sorted lastAt desc. Empty when no live session. Overlay-allowlisted (the shoutout ticker consumes it).
- `DashboardStatus` heartbeat: `GetDashboardStatusSnapshot` aggregates — persistence fields NOW: `activeChatters`(distinct usernames in chat_messages within 15min), `sessionChatters`(session store count), `knownChatters`(chatters count), `streamSessionId`/`streamSessionStartedAt`(active session); auth fields from Phase 2's TwitchAuthStatus; eventsub fields from Phase 2's EventSubStatus. OBS/ad/stream-live fields are Phase 8/OBS — include them in the DTO as null/absent for now (the shape must match `legacy/src/shared/api.ts` DashboardStatus; fill nullable). `DashboardHeartbeatService` (BackgroundService, under SkipInfrastructure guard): every 5s (DASHBOARD_HEARTBEAT_MS), SKIP if no connected clients (query the SignalR hub's connection count), else broadcast `dashboard:status` (operator-only). `GET /api/dashboard/status` → the same snapshot (REST seed == WS shape).

- [ ] Steps: failing tests (session-shoutouts groups a follow+resub for one actor into one entry with kinds=[follow,sub], most-recent detail, empty off-session; dashboard status aggregates the persistence counts + auth/eventsub status; heartbeat skips when no clients). Implement. Green + build. Commit `feat: session shoutouts and dashboard status heartbeat`.

---

## Deferred to later phases
- OBS stats, ad schedule, stream-live status in DashboardStatus (Phase 8/OBS) — nullable now.
- The go-live Discord announce flow that attaches discord ids to a session (Phase 8) — columns present, flow later.
- Viewer Helix details (followed/subbed/accountAge live lookups) — Phase 8; roster uses badge-derived only for now.
- stream_status overlay text (Phase 8) — not in Phase 3.
- The overlay `compact` hiding of moderated messages + the client dimming — Phase 6/7 (client).

## Self-Review
- Coverage: chat dual-layer (T1) + moderation (T2), sessions (T3), stream events (T4), viewers/roster/profiles (T5), automod (T6), shoutouts + status (T7). The notification split (ingested→broadcast) lands in T1/T4. The two idempotency rules preserved: automod (T6), sub-merge (Phase 2, unchanged).
- Cross-task: `ISessionStore`/`IStreamSessionStore` (T3) consumed by T1's enrichment + T7's count — sequence T3 before/with T1 or define the interface in T1 and implement in T3. `IChatStore` (T1) extended by T2. ChatterDocument last-message fields (T1) feed T5's roster. Phase 2 notifications (StreamOnline/Offline, Automod*, the chat/stream ingested split) are consumed here.
- Marten dedup = load-check-then-insert (not Store's upsert) for the natural-key documents.
