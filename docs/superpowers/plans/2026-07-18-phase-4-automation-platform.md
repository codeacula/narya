# Phase 4: Automation Platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** Port Narya's automation platform — the configured media catalog, reusable Actions (ordered steps), typed Triggers, the trigger dispatcher (matching + cooldowns + dedup + bot-loop/module guards), the server-owned slash commands, and the media-mute master switch — so a Twitch redemption/event/chat command fires an Action exactly once.

**Architecture:** Marten documents for the config (media_assets, actions with embedded steps, automation_triggers) + the automation_runs log (dedup + cooldown source). The Action executor is a plain injected service with per-step ports (so it's testable without Twitch/OBS/DB). The trigger dispatcher is a plain service; MediatR `INotificationHandler`s subscribe to Phase 2/3 **broadcast** notifications + dedicated automation signals and call the dispatcher. Media playback has EXACTLY ONE path: `resolveMediaAssetForPlayback` → `play_media` step → `media:play` broadcast.

**Tech Stack:** .NET 10, Marten, MediatR 13, FluentResults, Testcontainers Postgres, NSubstitute.

## Global Constraints
- MediatR 13 pinned; net10.0; no inline package versions (CPM); FluentResults; no blanket catch→Fail EXCEPT the executor's deliberate per-step catch and the dispatcher's per-invocation catch (documented).
- **The media choke point:** `resolveMediaAssetForPlayback(id)` returns null for unknown/disabled/unavailable; NO other path emits `media:play`. An injected `IMediaResolver` port (not a direct store call) into the executor preserves testability.
- **Executor concurrency (the trickiest piece):** all steps run as independent Tasks (`Task.WhenAll(steps.Select(RunStepAsync))`), each awaiting its OWN `delayMs` (relative to invocation start t0, NOT cumulative) before dispatch, with per-step try/catch so one step's exception never faults the WhenAll or aborts siblings. Pending delays are NOT persisted/replayed after a restart.
- **Dedup is a partial unique index**, not app-level locking: `dedupe_key = "{triggerId}:{eventId}"` (null-exempt); insert a PROVISIONAL run row BEFORE executing (status `failed`, detail "Invocation did not complete.") — the insert wins the redelivery race; update after with the real status. A check-then-insert has a TOCTOU gap — do NOT do that.
- **Slash commands are server-owned:** `POST /api/automation/slash` always returns HTTP 200; an unknown/cooling/unarmed command is `{ok:false}`, NEVER forwarded to Twitch.
- **media:mute** is operator-only (NOT overlay-allowlisted); the executor checks `quickDisable && isMuted()` ONCE at the top of `runAction` → skips the WHOLE run, broadcasts nothing.
- **media:play** and **overlay:text** are overlay-allowlisted WS events (the overlay renders them) — add `media:play` + `overlay:text` to `RealtimeEventNames.OverlayAllowlist` if not present.
- Read the legacy files for exact shapes: `legacy/src/server/{mediaAssets,media,actions,actionExecutor,actionTemplates,automation,automationTriggers,triggerDispatcher,mediaMute,rewardMedia}.ts`, `legacy/src/server/redeemOnce.test.ts`, and `legacy/src/shared/api.ts`.
- Commit `feat:`/`fix:`/`test:` + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer. Build 0/0; full `dotnet test Narya.sln` green.

## Media storage decision (companion-agent topology)
Local media files (`public/clips`, `public/sounds`) are the streamer-PC-local coupling. Phase 4 models the `media_assets` catalog + the resolution choke point, but the **local-file availability + serving** is deferred to Phase 5 (server-side storage / companion agent). For Phase 4: `IMediaFileCatalog` is a port — remote assets are always available; local availability is checked against the port (a minimal implementation for now, replaced in Phase 5). The invariant to preserve: a local `src` must resolve against an authoritative live-queried source (the port), never just pattern-validated.

---

### Task 1: Media assets catalog + resolution choke point
**Files:** `Narya.Database/Media/MediaAssetDocument.cs`, `Narya.Core/Media/{IMediaAssetStore,IMediaResolver,IMediaFileCatalog,MediaAsset}.cs`, `Narya.Database/Media/MediaAssetStore.cs` + `MediaResolver.cs`, `Narya.Api/Controllers/MediaAssetsController.cs`. Tests.
**Behavior (legacy mediaAssets.ts + media.ts):**
- `MediaAssetDocument`: Id, Label, Kind("audio"|"video"), SourceType("local"|"remote"), Src, Volume(0.8 default, [0,1]), Enabled, CreatedAt, UpdatedAt. `MediaAsset` (Core) adds derived `Available` (never stored).
- `IMediaFileCatalog` port: `bool IsAvailable(sourceType, src)` (remote→true; local→a catalog lookup — Phase 5 fills the real server-side catalog; a minimal impl now), `Kind? KindForLocalSrc(src)` (for validation). Plus `Discovered()` for the picker (files + configuredSrcs) — minimal for now.
- `IMediaResolver.ResolveForPlayback(id)` → `MediaAsset?`: null if unknown/`!Enabled`/`!Available`; else the asset. THE choke point.
- Validation (legacy normalize): label required ≤120?; sourceType local|remote; src required; local kind overridden by the catalog's actual kind (mismatch→400); remote requires http(s) URL; volume clamp [0,1] default 0.8; PUT is partial (fall back to current). DELETE blocked 409 if referenced by any action's `play_media` step assetIds (array membership).
- Routes (operator-only): GET/POST/PUT/DELETE /api/media-assets; GET /api/media/discovered.
- [ ] TDD: store round-trip; resolver returns null for disabled/unavailable/unknown; delete-blocked-if-referenced; validation. Commit `feat: media asset catalog with playback resolution choke point`.

### Task 2: Actions + steps repository + CRUD + validation
**Files:** `Narya.Database/Actions/ActionDocument.cs` (embeds a `List<ActionStepData>`), `Narya.Core/Actions/{IActionStore,Action,ActionStep,step payloads}.cs`, `Narya.Database/Actions/ActionStore.cs`, `Narya.Api/Controllers/ActionsController.cs`. Tests.
**Behavior (legacy actions.ts):**
- `ActionDocument`: Id, Name(unique case-insensitive), Description, Enabled, QuickDisable, Steps(embedded ordered list), CreatedAt, UpdatedAt. Save = whole-steps-replace (Marten stores the list; no step PATCH). Limits: MAX_STEPS 20, name ≤120, desc ≤500, template ≤500, delay ≤600000, text duration [1000,60000], ≤25 assets/step.
- The 11 step types as a discriminated union (a base `ActionStep {Id, Type, Position, Enabled, DelayMs}` + per-type payload): show_text{template,durationMs,style(banner|toast|centered),tone?}, play_media{assetIds[],selection(first|random),volume?}, tts_speak{template}, send_chat{template,sender(user|bot)}, llm_response{template}, obs_scene{sceneName}, obs_transition{}, twitch_shoutout{loginTemplate}, twitch_whisper{loginTemplate,template}, twitch_timeout{loginTemplate,secondsTemplate,reasonTemplate}, twitch_ban{loginTemplate,reasonTemplate}. (Match `legacy/src/shared/api.ts:708-772` exactly.) Validation per type (legacy actions.ts:139-230) — esp. twitch_timeout secondsTemplate literal-range-check when it has no `{`.
- Routes (operator-only): GET /api/actions (Action[]); POST (201); PUT (404/409-dup-name); DELETE (204, cascade steps); POST /api/actions/:id/run → executor.runAction (Task 3; bypasses dispatcher — no cooldown/dedup, not logged).
- [ ] TDD: store round-trip w/ embedded steps; whole-steps-replace on save; name-unique 409; the per-type validation. (POST :id/run wired in Task 3.) Commit `feat: Action repository with typed steps and validation`.

### Task 3: Template renderer + Action executor
**Files:** `Narya.Application/Actions/ActionTemplate.cs` (pure renderer), `Narya.Application/Actions/{ActionExecutor,IActionExecutor,ActionStepPorts}.cs`, `Narya.Core/Actions/{ActionRunResult,ActionStepResult}.cs`. Tests. (This is the big one.)
**Template renderer (legacy actionTemplates.ts):** `Render(template, TemplateContext)` single-pass regex `\{([A-Za-z][A-Za-z0-9]*)\}`; static tokens {actor}{login}{message}{input}{args}{rewardTitle}{amount}{tier}{months}{category}{module}; dynamic {arg1..N} (1-indexed, out-of-range→""), {rest}/{restN} (args.slice(from).join(' '), {rest}={rest1}); KNOWN token w/ undefined value → "" ; UNKNOWN token → left literal; single-pass (no re-expansion — anti-injection).
**Executor (legacy actionExecutor.ts):**
- `RunAction(actionId, TemplateContext)` → `ActionRunResult{ActionId, Status, Steps[], RanAt}`: load action; if missing/`!Enabled`→skipped(steps:[]); if `QuickDisable && isMuted()`→skipped(steps:[]) — checked ONCE at top, whole run skips, broadcasts nothing. Else `Task.WhenAll(action.Steps.Select(RunStepAsync))`; Status = rollUp.
- `RunStepAsync(step, ctx)`: if `!Enabled`→skipped; try { if DelayMs>0 await Delay(DelayMs); return Dispatch(step,ctx) } catch → failed(errorDetail). Per-step catch — never aborts siblings. Delay relative to t0.
- rollUp: ran = steps where status != skipped; ran.Count==0→skipped; all ran succeeded→succeeded; all ran failed→failed; else partial.
- Dispatch per type (inject ports — `IActionStepPorts` with each capability; ports for capabilities not yet built (tts, llm, obs) are minimal/soft-fail until Phase 5/8):
  - show_text: render template; blank→skipped("...rendered empty."); else emit `overlay:text` OverlayTextPlayback{id,text,durationMs,style,tone?} (ONLY the resolved playback, never raw config).
  - play_media: pickAsset(assetIds,selection) via `IMediaResolver` (filter enabled&available; empty→skipped); first→[0], random→clamp(floor(rand*len)); volume = step.volume ?? asset.volume; emit `media:play` MediaPlayback{kind,src,volume, actor}. → succeeded.
  - tts_speak: render; blank→skipped; else await ITtsPort.Speak(text) (Phase 5 companion — port; soft until then). → succeeded.
  - send_chat: render; blank→skipped; await IHelixClient.SendChatMessageAsync(sender==user?Broadcaster:Bot, text). → succeeded.
  - llm_response: render prompt; blank→skipped; answer = await ILlmPort.Ask(ctx, prompt) (Phase 8 — port); blank answer→skipped; await SendChat(Bot, answer). → succeeded.
  - obs_scene / obs_transition: await IObsPort.SwitchScene(name)/Transition() (Phase 5 companion — port). → succeeded.
  - twitch_shoutout: login=normalize(render(loginTemplate)) (trim, strip @, lower); blank→skipped; await IHelixClient.SendShoutoutAsync(login). twitch_whisper: login+message; twitch_timeout: login + renderTimeoutSeconds (round(Number); invalid/out-of-range→DEFAULT 600, NOT fail) + reason; await IHelixClient.BanOrTimeoutAsync(userId?, seconds, reason) — NOTE Helix needs a user id; resolve login→id via IHelixClient.ResolveUserIdAsync; twitch_ban: login + reason.
  - The IHelixClient moderation/shoutout/whisper take ids; resolve the login→id (ResolveUserIdAsync) inside the step. shoutout/whisper also need target ids.
- `POST /api/actions/:id/run` wired here → runAction(id, normalizeRunContext(body)); 404 if action missing.
- [ ] TDD (all with test doubles — NO real Twitch/DB): renderer token cases (statics, arg/rest, unknown-literal, known-empty, no-re-expansion); executor: delay-relative-to-t0 (two steps delayMs=2000 start together, not cumulative — assert with a controllable delay + clock); a failing step doesn't abort siblings; rollUp (all-succeeded, all-failed, mixed→partial, all-skipped→skipped); quickDisable+muted→whole-run-skipped-broadcasts-nothing; show_text blank→skipped; play_media through resolver (unavailable→skipped); the moderation steps resolve login→id. Commit `feat: Action template renderer and step executor`.

### Task 4: media-mute + realtime wiring
**Files:** `Narya.Database/Automation/MediaMuteDocument.cs` (single row) + `Narya.Core/Automation/IMediaMuteStore.cs` + store, `Narya.Api/Controllers/MediaMuteController.cs`, a `MediaMuteBroadcastNotification`/`media:mute` event. Add `media:play`/`overlay:text` to OverlayAllowlist (if absent); `media:mute` operator-only. Tests.
**Behavior (legacy mediaMute.ts):** MediaMuteDocument single row (Id=1, Muted). `GetMediaMutedAsync`; `SetMediaMutedAsync(bool)` upsert + broadcast `media:mute` {muted}. Routes operator-only: GET/PUT /api/automation/media-mute (PUT reads `muted===true` strict, else false). The executor's `isMuted` port = GetMediaMutedAsync.
- [ ] TDD: get/set round-trip + broadcast; PUT strict-true; media:mute NOT overlay-allowlisted (routing test); media:play/overlay:text ARE. Commit `feat: media-mute master switch and realtime media event allowlist`.

### Task 5: Automation triggers repository + CRUD + seeded slash commands
**Files:** `Narya.Database/Automation/AutomationTriggerDocument.cs`, `Narya.Core/Automation/{IAutomationTriggerStore,AutomationTrigger,trigger configs}.cs`, store, `Narya.Api/Controllers/AutomationTriggersController.cs`, a seed one-shot (runOnce-equivalent). Tests.
**Behavior (legacy automationTriggers.ts):**
- `AutomationTriggerDocument`: Id, Kind, ActionId, ModuleId?(null=global), Enabled, ConfigJson(kind-specific), GlobalCooldownMs(30000), UserCooldownMs(60000), timestamps. 8 kinds + configs (§5 of the spec): reward{rewardId}, twitch_event{eventKind:sub|gift|cheer|raid|follow}, chat_phrase{phrase,match:exact|contains|starts_with,roles[]}, viewer_command{command(normalized !x),aliases[],roles[]}, dashboard_slash{command(normalized /x),aliases[]}, manual{label}, module_activate{}, module_deactivate{}. Cooldown normalize (default/floor/cap 24h; 0 disables). ActionId must exist (validate); ModuleId if set must exist (Phase 8 category_modules — for now, a module-existence port that returns false until Phase 8, so module-scoped triggers can't be created yet OR allow-and-note; simplest: allow moduleId but note it's dormant until Phase 8's coordinator).
- Routes (operator-only): GET/POST/PUT/DELETE /api/automation/triggers; POST /:id/run (Task 6). 
- **Seeded slash commands** (once, via a runOnce-equivalent / a seed on boot guarded by a schema_migrations-style ledger — reuse Phase 1's runOnce if present): Shoutout(/shoutout,/so→twitch_shoutout loginTemplate {arg1}), Whisper(/whisper,/w→twitch_whisper {arg1}/{rest}), Timeout(/timeout→twitch_timeout {arg1}/{arg2}/{rest2}), Ban(/ban→twitch_ban {arg1}/{rest}) — all cooldowns 0, single step; each needs its Action created too (name-collision-avoid). Idempotent.
- [ ] TDD: store round-trip per kind; config validation (command normalization !x//x, cooldown clamp, eventKind enum); seed creates the 4 slash Actions+triggers once (idempotent). Commit `feat: automation triggers with typed configs and seeded slash commands`.

### Task 6: Trigger dispatcher + automation_runs + MediatR wiring
**Files:** `Narya.Application/Automation/{TriggerDispatcher,ITriggerDispatcher}.cs`, `Narya.Database/Automation/AutomationRunDocument.cs` (+ a **partial unique index on dedupe_key**) + store, the MediatR handlers (`Narya.Application/Automation/*Handler.cs`) subscribing to Phase 2/3 notifications, Phase 2 dispatcher additions (publish automation signals), `Narya.Api` routes. Tests.
**Behavior (legacy triggerDispatcher.ts):**
- `AutomationRunDocument`: Id, TriggerId, DedupeKey?("{triggerId}:{eventId}"), ActorLogin?, Status, Detail, RanAt. **Partial unique index on DedupeKey where not null** (Marten: `options.Schema.For<AutomationRunDocument>().Index(x=>x.DedupeKey, i=>{i.IsUnique=true; i.Predicate="dedupe_key is not null";})` — verify the Marten 8.37.4 partial-unique-index API). Insert-provisional-before-run (status failed/"Invocation did not complete."); the insert winning = claim; a unique-violation on insert = dedup hit (return false, don't run). finishRun updates status/detail after.
- `ITriggerDispatcher` (a plain service, NOT a MediatR handler): `Invoke(trigger, ctx, {eventId, actorLogin, enforceGates})` choke point — if enforceGates: isArmed (moduleId null || == activeModuleId) + isOnCooldown (global: last run for trigger; user: last run for trigger+actor — both from automation_runs, any status); claim (insert provisional, dedup); runAction; finishRun. Cooldowns/dedup from automation_runs. `HandleChatMessage(ChatMessage)` (bot-loop guard FIRST: bot login → return; then chat_phrase + viewer_command matching, role filter, all matches are candidates, invokeAll sequential); `HandleTwitchEvent(TwitchEventSignal{kind,eventId,actor,login,amount,tier,months})`; `HandleRewardRedemption(RewardRedemptionSignal{eventId,rewardId,rewardTitle,actor,login,userInput})`; `HandleModuleLifecycle(phase,moduleId,name)` (Phase 8 wires the caller; build the method, enforceGates:false); `RunTriggerManually(id,ctx)` (enforceGates:false); `HandleSlashCommand(input)` (§8 — always returns {ok,message,run}; /command binds actor/login to the TARGET args[0]; never forwards to Twitch).
- **MediatR wiring:** handlers subscribing to Phase 2/3 BROADCAST notifications (post-persist, per the Phase 3 final-review recommendation): `ChatMessageBroadcastNotification` → HandleChatMessage. For reward + twitch events, the dispatch needs eventId + structured data (amount/tier/months/rewardId/userInput) that the persistence notifications don't carry — so ADD dedicated automation-signal notifications the Phase 2 EventSub dispatcher publishes alongside the stream-event ones: `RewardRedeemedSignalNotification`/`TwitchEventSignalNotification` (carry the EventSub message id as eventId + the structured fields). Handlers on those → HandleRewardRedemption/HandleTwitchEvent. (Touch Phase 2's EventSubDispatcher/TwitchEventSubService to publish these signals — keep Phase 2 tests green.)
- Routes: POST /api/automation/triggers/:id/run → RunTriggerManually; POST /api/automation/slash → HandleSlashCommand (always 200). Operator-only.
- **automation_runs prune** (7-day retention, boot + 24h) — a hosted service or a boot task.
- [ ] TDD (Testcontainers for the dedup index + cooldowns; doubles for runAction): claim inserts provisional + a duplicate dedupeKey insert returns false (dedup); cooldown (global + user) from run rows; isArmed (module scoping); bot-loop guard skips the bot's messages; chat_phrase exact/contains/starts_with matching + role filter + multi-candidate; twitch_event kind match; reward rewardId match; slash command (unknown→ok:false, cooling→ok:false, success→ok:true, never forwards); manual run bypasses gates. Commit `feat: trigger dispatcher with dedup, cooldowns, and MediatR wiring`.

### Task 7: Redeem-once invariant test (the regression guard)
**Files:** `tests/Narya.Application.Tests/Automation/RedeemOnceTests.cs` (or an integration test) — port of `legacy/src/server/redeemOnce.test.ts`.
**Behavior:** end-to-end through the real dispatcher + executor (media broadcast intercepted): (1) a reward redemption fires `media:play` EXACTLY ONCE (a `reward` trigger → `play_media` Action; no second path); (2) a follow fires overlay:text + media:play exactly once (a `twitch_event` trigger → show_text+play_media Action); NO retired-path event name (`alert:show`) exists; (3) a REDELIVERED signal (same eventId) does NOT replay `media:play` (0 on the second delivery) — proves the partial-unique-index dedup against a real redelivery. This is THE load-bearing guard: media playback has exactly one path and a redelivery can't double-fire it.
- [ ] TDD: the 3 assertions above. Commit `test: redeem-once invariant (media plays exactly once, redelivery does not replay)`.

---

## Deferred to later phases
- Media file STORAGE + serving + the filesystem-scan replacement (Phase 5 companion/server storage) — Phase 4 uses the `IMediaFileCatalog` port with a minimal impl.
- tts_speak (companion Chatterbox), obs_scene/transition (companion OBS) — Phase 5 fills those ports; Phase 4 wires soft/minimal ports.
- llm_response (Phase 8 LLM) — port.
- module_activate/deactivate DISPATCH (the category coordinator that calls HandleModuleLifecycle) — Phase 8; Phase 4 builds the method + the trigger kinds; getActiveModuleId returns null until then (module-scoped triggers dormant).
- Reward CRUD / category modules — Phase 8.

## Self-Review
- Coverage: media catalog + choke point (T1); actions + steps (T2); template + executor incl. the delayMs-concurrency + rollup + mute check (T3); media-mute (T4); triggers + configs + seeds (T5); dispatcher + dedup + cooldowns + slash + MediatR wiring (T6); redeem-once guard (T7).
- Cross-task: IMediaResolver (T1) → executor (T3); IActionStore (T2) → executor (T3) + dispatcher (T6); the executor (T3) → dispatcher.runAction (T6); automation_runs partial-unique-index (T6) = the dedup; the Phase 2 dispatcher additions (T6) publish the automation signals.
- The one architecture fork (media storage) is deferred to Phase 5 behind IMediaFileCatalog; the invariant (local src resolves against an authoritative source) is preserved by the port.
- Ports for not-yet-built capabilities (tts/obs/llm) are wired minimally in T3 so a step using them fails soft / no-ops until Phase 5/8 — the executor + dispatcher are fully testable now.
