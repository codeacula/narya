# LLM provider profiles — design

Date: 2026-11-14 · Status: awaiting approval

## Intent

Let Narya's LLM (the `llm_response` Action step and the Settings test button) use
third-party hosted endpoints — specifically OpenCode Go — not just an OpenAI
Responses-compatible base URL. The operator picks one provider from a dropdown; each
provider remembers its own key, model, and endpoint, so switching between OpenCode Go
and a local LM Studio never means re-pasting a key.

## Goals

- A provider dropdown in Settings → LLM; exactly one provider is active at a time.
- Per-provider saved profile: base URL, API key, model, API format.
- Presets that know each provider's endpoints, default request format, and any
  required headers.
- Support the OpenAI **Chat Completions** request format in addition to today's
  Responses format.
- Automatically load the provider's model list whenever the provider is reachable,
  and offer it as suggestions in the model field.

## Non-goals

- Several providers in use at once, or a per-Action-step provider choice.
- Anthropic Messages / Google formats (OpenCode Go's Console translates formats;
  add one later only if a model needs it).
- Migrating the current `llm_settings` base URL / model / key — the operator has
  nothing worth keeping there. Profiles start from preset defaults.

## Anti-goals

- An API key ever reaching the browser. Model listing is proxied through the server.
- A model field that becomes unusable when model loading fails — it stays free text.

## Constraints

- OpenCode Go asks clients to send their own `User-Agent` (not a generic SDK name) and
  a stable `x-opencode-session` header per conversation. Go also states its intended
  use is coding-agent traffic and that traffic is monitored; using it for a chat bot
  is the operator's call, flagged once here.
- OpenCode Go endpoints are not a single `base + /suffix`: chat completions live at
  `https://opencode.ai/inference/go/openai/v1/chat/completions`, Responses at
  `.../go/openai/v1/responses`, and the model list at `.../go/v1/models`.
- Schema changes must be idempotent (`create table if not exists`,
  `addColumnIfMissing`); the operator's `bun --watch` can persist intermediate shapes.

## Approaches considered

- **A. Saved provider profiles, one active (chosen).** A table of per-provider
  profiles plus an active-provider pointer; presets supply endpoints/format/headers.
  Matches "configure individual providers" without re-entering keys on switch.
- B. One settings row + provider/format columns. Smallest, but switching providers
  overwrites the key and model.
- C. Only an API-format field, no presets. Least code; Go's URLs and headers become
  hand-typed and the session header is never sent.

## Design

**Storage.** New table `llm_providers (id text primary key, base_url, api_key, model,
api_format, updated_at)`, one row per preset id, created lazily with the preset's
defaults. `llm_settings` gains `active_provider text` (default `'local'`) via
`addColumnIfMissing`. Shared bot-behaviour fields — enabled, personality prompt,
temperature, max output tokens, timeout — stay on `llm_settings`. The old
`base_url`/`model`/`api_key` columns on `llm_settings` are left in place and unread.

**Presets** (server-side code literal, one object each; adding OpenRouter etc. later
is a new entry):

| id | label | default base URL | default format | extra headers |
|---|---|---|---|---|
| `opencode-go` | OpenCode Go | `https://opencode.ai/inference/go` | chat_completions | `User-Agent: narya/<version>`, `x-opencode-session` |
| `openai` | OpenAI | `https://api.openai.com/v1` | responses | — |
| `local` | Local (LM Studio, etc.) | `http://localhost:1234/v1` | responses | — |
| `custom` | Custom (OpenAI-compatible) | empty | chat_completions | — |

Each preset maps a format to its endpoint path: OpenCode Go uses
`/openai/v1/responses`, `/openai/v1/chat/completions`, `/v1/models`; the others use
`/responses`, `/chat/completions`, `/models` relative to the base URL. The base URL
stays editable on every profile.

**Request formats.** `callLlm` dispatches on the active profile's `api_format`:

- `responses` — today's body (`instructions`, `input`, `max_output_tokens`).
- `chat_completions` — `messages: [{role:'system', content: instructions},
  {role:'user', content: input}]`, `max_tokens`, `temperature`.

`extractResponseText` already reads both shapes; keep it as the single parser.
Auth stays `Authorization: Bearer <key>`.

**Session header (OpenCode Go).** `runLlmRequest` gains an optional conversation key;
the `llm_response` step passes the viewer's login. The header value is a short SHA-256
of that key (stable per viewer, so prompt caching works); the test button uses a fixed
`settings-test` key.

**Model loading.** `GET /api/llm/providers/:id/models` calls the provider's models
endpoint server-side with its stored key and returns `{ ok, models: string[] }` or
`{ ok:false, error }` (never a 5xx for an unreachable provider). The client calls it
automatically: on Settings load for the active provider, when the dropdown switches
provider, and after a successful save — whenever the profile has a base URL (and a
key, for providers that need one). Results populate a `<datalist>` on the model input;
failure shows a small inline note ("Couldn't load models: …") and leaves the field as
free text.

**API contract** (`src/shared/api.ts`): `LlmSettings` gains `activeProvider` and
`providers: LlmProviderProfile[]` (`id, label, baseUrl, model, apiFormat,
apiKeyConfigured, requiresApiKey`); the top-level `baseUrl`/`model`/`apiKeyConfigured`
are removed. `LlmSettingsUpdate` carries `activeProvider` plus the edited profile
(`baseUrl, model, apiFormat, apiKey?, clearApiKey?`). Keys are never returned.

**UI** (Settings → LLM):

```
Provider   [ OpenCode Go        ▾ ]
Base URL   [ https://opencode.ai/inference/go ]
API key    [ ••••••• configured ]  [Clear]
Format     [ Chat Completions ▾ ]
Model      [ kimi-k3            ]   ✓ 24 models loaded
— shared —
Personality prompt / temperature / max tokens / timeout   (unchanged)
[Save]     Test: [ why is CSS like this? ] [Test]
```

Switching the dropdown shows that provider's saved fields; Save makes it active.

## Left to the builder

- Exact `User-Agent` version source (package.json version is fine).
- Whether to add a short in-memory cache for model lists (not required).
- Test coverage: request-body shape per format, OpenCode Go URL/header construction,
  key never present in any GET payload, model-list failure returns `ok:false`.
