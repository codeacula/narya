# LLM Action steps: context, targeting, and declining

Date: 2026-07-20
Status: approved design, not yet implemented

## Problem

The `llm_response` Action step is `{ template: string }` and nothing else. It renders
the template, hands it to `askPonderLlm`, and unconditionally publishes the answer to
Twitch chat as the bot.

Three consequences the operator cannot currently work around:

- **The prompt frame is hardcoded and wrong for most steps.** `askPonderLlm` wraps every
  prompt in `A Twitch chatter named X asks: {question}\nAnswer them in one concise chat
  message.` and force-prefixes the reply with `@displayName`. That framing is a `!ponder`
  artifact: `!ponder` no longer exists as a chat branch, and `askPonderLlm` now has exactly
  one caller, `actionExecutor`. (The settings test route reaches past it to `callLlm`,
  `userContent`, and `formatPonderReply` directly.) Every Action LLM step therefore reads
  like a Q&A whether or not it is one.
- **There is one system prompt for the whole app.** `llm_settings.personality_prompt` is
  global, so a step cannot carry rules of its own without the operator rewriting the
  channel's entire personality.
- **The model has no idea who is talking and no way to stay quiet.** The step cannot see
  the speaker's role or the operator's own viewer tags, and it always sends something.

The motivating case: `!lurk` should answer a moderator differently from a regular viewer,
and should produce nothing at all for a viewer the operator has tagged `no-llm`.

## Non-goals

- No token budgeting. There is no tokenizer for whatever model sits behind the configured
  base URL, so a character or token budget would be a guess presented as a guarantee.
  Context size is expressed in units the operator can reason about — lines and exchanges —
  and overflow is the operator's problem. The caps in this document exist to stop a typo
  from hanging a live stream, not to manage a context window.
- No new destination. An LLM step announces to Twitch chat through the same `sendChat`
  seam every other step uses, exactly as `quote_show` does. Discord stays send-only.
- No gate on the trigger. Tag targeting lives on the step, not on `automation_triggers`.

## Design

### 1. Payload

`LlmResponsePayload` in `src/shared/api.ts` grows from `{ template }` to:

```ts
export type LlmSystemPromptMode = 'enhance' | 'override';

export type LlmExample = { input: string; output: string };

export type LlmResponsePayload = {
  /** The user-message prompt, rendered against the invocation context. */
  template: string;
  /** Step-level system prompt. Empty means the global personality prompt alone. */
  systemPrompt: string;
  /** enhance: appended to the global personality prompt. override: replaces it. */
  systemPromptMode: LlmSystemPromptMode;
  /** Recent channel chat lines to include as context. 0 = none. */
  chatHistoryLines: number;
  /** Prior exchanges between this viewer and the bot to replay. 0 = none. */
  interactionHistory: number;
  /** Operator-written few-shot pairs. */
  examples: LlmExample[];
  /** Tag gate against the invoking viewer's profile tags. */
  allowTags: string[];
  denyTags: string[];
  /** When true, ask for structured JSON and honour a refusal to respond. */
  allowDecline: boolean;
  /** Prefix the reply with `@displayName`. */
  mention: boolean;
};
```

#### Back-compat is a read-boundary concern, not a type concern

`rowToStep` in `src/server/actions.ts` parses `payload_json` and blind-casts it to the
step union. Every stored `llm_response` row is `{ template }`, so on the day this ships,
every new field arrives as `undefined` at runtime while the type asserts it is present.

Defaulting therefore happens **in `rowToStep`**, not in the executor. A per-type
`defaultStepPayload` hook fills missing fields on the way out of the database, so the
union is honest and the executor never needs `?? false`. Scattering defensive reads
through `dispatch` would leave the type lying and put the same defaults in several places.

Defaults must reproduce today's behaviour exactly:

| Field | Default | Why |
|---|---|---|
| `systemPrompt` | `''` | Global personality prompt alone, as now. |
| `systemPromptMode` | `'enhance'` | An empty step prompt makes the mode moot; `enhance` is the safe reading. |
| `chatHistoryLines` | `0` | No context is sent today. |
| `interactionHistory` | `0` | No memory exists today. |
| `examples` | `[]` | |
| `allowTags` / `denyTags` | `[]` | Empty allow-list means everyone; empty deny-list blocks nobody. |
| `allowDecline` | `false` | The step always speaks today. |
| `mention` | `true` | **`formatPonderReply` prefixes `@displayName` unconditionally today.** Defaulting this to `false` would silently strip the mention from every existing step. |

`normalizeStepPayload` (the write path) validates the same fields per section 7.

### 2. Tag gate

Evaluated **before** the LLM call, so a denied viewer costs no tokens and no latency.

Rules:

- Deny beats allow. A viewer carrying both a denied and an allowed tag is denied.
- An empty `allowTags` means everyone.
- Comparison uses the shared normalizer (section 8). The Viewer Profile modal already
  normalizes on save; the server has never normalized at all. Without one shared
  function, a tag typed `No-LLM` will not match a gate configured as `no-llm`, and the
  failure is silent — the step just answers someone it was told not to.
- **A denied match yields `skipped`, not `failed`.** A tagged viewer running the command
  is normal traffic. This is the same rule `quote_show` applies to a query that matches
  nothing: a `failed` run reads as "Narya is broken" on the dashboard.

Edge case, stated deliberately: an invocation with **no login** — a module lifecycle
trigger, a manual run from the dashboard — has no profile and therefore no tags. Deny
cannot match, so it passes. An `allowTags` list, however, **rejects** it. That is correct:
"only these tags may use this" does not describe an anonymous invocation. It is written
down because the asymmetry looks like a bug to anyone reading the gate cold.

Tag lookup is injected into the executor as `resolveViewerTags: (login: string) => string[]`,
alongside the existing `resolveMedia` port, so the executor's tests need no database.

### 3. Prompt assembly

New module `src/server/llmPrompt.ts`. Pure functions only — no database access, no
`fetch` — so the whole assembly is unit-testable without a server or a model.

```ts
buildLlmRequest(input: {
  personalityPrompt: string;
  payload: LlmResponsePayload;
  context: TemplateContext;
  chatLines: ChatLine[];
  interactions: LlmInteraction[];
}): { instructions: string; input: string }
```

**`instructions`** carries the durable contract:

1. The persona — `override` uses the step's `systemPrompt` alone; `enhance` joins the
   global `personalityPrompt` and the step's with a blank line, skipping either if empty.
2. The few-shot examples, if any.
3. The decline contract, if `allowDecline` (section 4).

**`input`** carries the situational material, in a fixed order so a cached prefix stays
stable:

1. Actor block — `Speaker: Bob (@bob) — roles: mod, sub — tags: artist, regular`.
2. Recent chat lines, oldest to newest, if `chatHistoryLines > 0`.
3. Prior interactions, oldest to newest, if `interactionHistory > 0`.
4. The rendered `template`.

Empty sections are omitted entirely rather than emitted as empty headers.

The hardcoded `A Twitch chatter named X asks:` frame is **removed** from the Action path.
This is what makes the motivating case work without any model-side cleverness: the actor
block states the role, and the operator's system prompt says "if they are a moderator,
answer briefly and defer to them." No role-specific branching in code.

`askPonderLlm` is retired in favour of a function taking the assembled request. The
settings test route (`POST /api/llm/test`) already reaches past it to `callLlm` and keeps
its own synthetic framing, so "test speak" still exercises a realistic round trip.

Retiring `askPonderLlm` also moves the `@mention`, which it applied unconditionally via
`formatPonderReply`. The executor now applies it, gated on `payload.mention`: the reply is
prefixed with `@${context.actor || context.login}` when the flag is set and the context has
one, and sent bare otherwise. `formatPonderReply`'s 500-character Twitch truncation moves
with it and applies in both cases — a long generated reply must still be a legal chat
message.

### 4. Declining to respond

When `allowDecline` is true, `instructions` gains:

> Reply with a single JSON object and nothing else: `{"respond": true, "message": "..."}`
> to answer, or `{"respond": false}` to stay silent. Do not wrap it in code fences.

`parseLlmReply(raw: string, allowDecline: boolean)` resolves it:

- `allowDecline === false` → `{ respond: true, message: raw }`. Today's path, untouched.
- Strip a leading/trailing code fence, then take the first balanced `{…}` and `JSON.parse`.
- `respond === false` → the step **skips**: nothing is sent, and **nothing is recorded to
  interaction history**. A silence is not a conversational turn; replaying it as one would
  teach the model that empty replies are an acceptable shape.
- A parsed object with a non-empty string `message` → use it.
- **Anything else → treat the whole raw text as the message**, and log once.

That last rule is the deliberate one. Local models behind an arbitrary base URL fumble
strict JSON regularly, and the alternative — swallowing the reply — turns a formatting
quirk into a command that mysteriously stops working on stream. The gate that carries the
safety weight is the deny-list in section 2, which never depends on model compliance.
Declining is a nicety layered on top of it.

### 5. Interaction memory

Keyed by **login alone**. There is one bot, so its memory of a person spans commands:
a viewer who asks something under one command and follows up under another is having one
conversation.

```sql
create table if not exists llm_interactions (
  id text primary key,
  login text not null,
  prompt text not null,
  reply text not null,
  created_at text not null
);
create index if not exists idx_llm_interactions_login
  on llm_interactions(login, created_at);
```

- **Written after the chat send succeeds**, not when the model returns. This is the same
  rule `quote_show` applies to `shown_count`: a chat outage must not record an exchange
  the viewer never saw. Replaying an undelivered reply as "you said this" would make the
  model's account of the conversation diverge from the room's.
- Declines are not recorded (section 4).
- An invocation with no login neither reads nor writes.
- Pruned on insert to the newest `MAX_STORED_INTERACTIONS` (50) per login. Only the newest
  handful are ever read, so unbounded growth buys nothing.
- **`flushViewer` deletes these rows inside its existing transaction**, and the count
  rides back on `ViewerFlushResult` next to `quotesAnonymized`. This is viewer chat
  content — precisely what a flush exists to remove. Leaving it behind would mean a
  flushed viewer's words keep shaping the bot's replies. Unlike quotes, there is no
  circulating public identifier to preserve, so this is a delete, not an anonymize.

### 6. Chat history

Reads `chat_messages` newest-first, reversed, **excluding rows with `deleted_at` set**.

Replaying a moderated message into the model's context would resurrect exactly the content
moderation removed, and could put it back on stream inside a generated reply. Injected as
a port for the same testability reason as the tag lookup.

Bot messages are left in. They are part of the room, and interaction memory is a separate,
better-shaped record of what the bot itself said.

### 7. Limits

Enforced in `src/client/pages/settings/automation.ts` (React-free and already covered by
tests) and re-enforced in `normalizeStepPayload` on the server, since the client is not a
trust boundary.

| Field | Limit |
|---|---|
| `chatHistoryLines` | 0–50 |
| `interactionHistory` | 0–20 |
| `examples` | ≤10 pairs, ≤500 chars per side |
| `systemPrompt` | ≤2000 chars, matching the global personality prompt's cap |
| `allowTags` / `denyTags` | ≤20 each, normalized, empty entries dropped |
| `template` | unchanged: required, ≤500 chars |

These are guardrails, not a budget. Per the non-goals, blowing the model's context is the
operator's call to make; hanging the stream with a mistyped `100000` is not.

### 8. Shared tag normalization

`normalizeProfileTag` and `addProfileTag` move from `src/client/ui/panels.tsx` to
`src/shared/`. Call sites after the move: the Viewer Profile modal, the two new tag
editors on the LLM step, and the server-side gate. Section 2 depends on this being one
function rather than three implementations.

### 9. Template context

`TemplateContext` gains `role?: string` and `tags?: string[]`, populated in
`triggerDispatcher` from the badges it already reads for `passesRoleFilter` and from the
profile lookup. This makes `{role}` and `{tags}` available to every template, not only to
LLM steps, and it is what the actor block in section 3 renders from.

## UI

Verified against the Narya design system project (`ef93b6e0`), which mirrors the 19
exported upstream components.

**The design system exports no form controls** — no input, textarea, select, checkbox,
radio, chip editor, or disclosure. No settings component is exported at all. So this work
follows the Action step editor's local idiom (`.field`, `.settings-wide-field`,
`.action-hint`) and adds nothing to the design system.

- **Grouping is a separator, not a collapsible.** The DS has no disclosure component, and
  hiding a deny-list behind a click would conceal the one setting that makes a command
  silently stop replying. A `.action-step-group` rule matching `TweakSection`'s `.twk-sect`
  idiom — small, uppercase, `--track-caps` — groups the fields in place. `TweakSection`
  itself is not imported: it is a dashboard tweaks-panel component that injects its own CSS
  from JS and does not belong in the settings tree.
- **Tag editors reuse `.tag-chip-list` / `.tag-chip`** (`panel.css:2323`), already built
  for the Viewer Profile modal — pill chips, mono 10px, `--danger-fg` / `--danger-bg` on
  remove hover.
- **System prompt** — `.field.settings-wide-field` with a `<textarea>`; `.field textarea`
  is styled at `panel.css:2194` and `LlmSection.tsx:153` is the precedent.
- **`systemPromptMode`** — `<select>`, matching `send_chat`'s "Send as".
- **`chatHistoryLines` / `interactionHistory`** — `<input type="number">` in a `.field`.
- **`allowDecline` / `mention`** — `<select>` with explicit on/off options, **not
  checkboxes**. The step editor has no checkbox precedent; every boolean in it is a select.
- **`examples`** — the repeatable-row idiom already used for asset lists and trigger
  aliases.

Token discipline: `--warning` bare is not a token (the family is `--warning-base` / `-fg` /
`-bg` / `-border`), and `--orb`, `--reward-color`, `--overlay-text-accent` are assigned
from JS at runtime — nothing authors against them.

Out of scope, worth revisiting: the tag-chip editor will have three call sites after this
change, making it the strongest candidate for the design system's first shared form
control. That is its own change.

## Testing

- `llmPrompt.test.ts` — assembly order, `enhance` vs `override`, omission of empty
  sections, actor block with and without role and tags.
- `parseLlmReply` — fenced JSON, bare JSON, `respond: false`, and garbage falling through
  to raw passthrough.
- Tag gate — deny beats allow; allow-list rejects a login-less invocation; a tag differing
  only by case and punctuation still matches.
- Interaction memory — recorded only after a successful send; not recorded on decline;
  pruning holds at the cap; `flushViewer` removes the rows and reports the count.
- Chat history — a soft-deleted message never reaches the prompt.
- Reply shaping — `mention: true` prefixes, `mention: false` does not, and a reply longer
  than 500 characters is truncated in both cases.
- Back-compat — a stored `{ template }` payload loads with `mention: true` and produces
  byte-identical output to today.

Limits are tested with **violating** values, not defaults: asserting a clamp by calling it
with its own default passes even when the clamp is deleted. Each cap gets a mutation check
confirming the test fails when the bound is removed.

## Verification

`bun run typecheck`, `bun test`, `bun run build`, plus a Chromium pass over the Action
editor for the new controls. The LLM path is exercised against a local model; the decline
parser's garbage-input branch is covered by unit tests rather than by trying to provoke a
real model into emitting malformed JSON.
