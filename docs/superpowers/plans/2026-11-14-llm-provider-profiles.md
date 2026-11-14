# LLM Provider Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single LLM base-URL/model/key with per-provider saved profiles (OpenCode Go, OpenAI, Local, Custom), one active, with Chat Completions support and automatic model-list loading.

**Architecture:** A pure `llmProviders.ts` owns presets, endpoint URLs, request bodies, and headers. `llm.ts` owns storage (new `llm_providers` table + `llm_settings.active_provider`), transport, and routes. The Settings LLM section gains a provider dropdown, a format select, and a model `<datalist>` fed by a server-proxied models route.

**Tech Stack:** Bun, Express, bun:sqlite, React, TypeScript.

**Spec:** `docs/superpowers/specs/2026-11-14-llm-provider-profiles-design.md`

## Global Constraints

- Preset ids exactly: `opencode-go`, `openai`, `local`, `custom`. Default active: `local`.
- API formats exactly: `responses`, `chat_completions`.
- OpenCode Go base `https://opencode.ai/inference/go`; paths `/openai/v1/responses`, `/openai/v1/chat/completions`, `/v1/models`. Others: `/responses`, `/chat/completions`, `/models` relative to base.
- OpenCode Go headers: `User-Agent: narya/<package.json version>`, `x-opencode-session: <first 32 hex chars of sha256(conversationKey)>`. Test button key: `settings-test`; Action step key: the viewer login, else `anonymous`.
- API keys never appear in any GET/PUT response body; only `apiKeyConfigured`.
- Model listing never returns 5xx for an unreachable provider: `{ ok: false, error }` with 200.
- No data migration from the old `llm_settings.base_url/model/api_key` columns; they stay and are unread.

## Review Focus

- Unknown provider id in PUT or models route → 400/404, never creates a row. (Task 2, Task 3 tests)
- Switching provider in a PUT without `apiKey` keeps that provider's stored key, and does not copy the previous provider's key. (Task 2 test)
- Models endpoint returning non-JSON or a shape without `data[]` → `{ ok:false }`, not a throw. (Task 3 test)
- Base URL with trailing slash → no `//` in built URLs. (Task 1 test)
- `maxOutputTokens = 0` (unlimited) → no token cap field in either body format. (Task 1 test)

---

### Task 1: Pure provider module

**Files:**
- Create: `src/server/llmProviders.ts`
- Test: `src/server/llmProviders.test.ts`

**Interfaces:**
- Produces (also add the two types to `src/shared/api.ts`):
  - `type LlmProviderId = 'opencode-go' | 'openai' | 'local' | 'custom'`
  - `type LlmApiFormat = 'responses' | 'chat_completions'`
  - `type LlmProviderPreset = { id: LlmProviderId; label: string; defaultBaseUrl: string; defaultFormat: LlmApiFormat; requiresApiKey: boolean; paths: { responses: string; chat_completions: string; models: string }; sendsOpencodeSession: boolean }`
  - `LLM_PROVIDER_PRESETS: readonly LlmProviderPreset[]` (order = dropdown order: opencode-go, openai, local, custom)
  - `getPreset(id: string): LlmProviderPreset | null`
  - `isLlmApiFormat(value: unknown): value is LlmApiFormat`
  - `endpointUrl(preset, baseUrl: string, kind: 'responses' | 'chat_completions' | 'models'): string`
  - `buildRequestBody(format, { model, instructions, input, temperature, maxOutputTokens }): Record<string, unknown>`
  - `buildHeaders(preset, apiKey: string, conversationKey: string): Record<string, string>`

- [ ] **Step 1: Write failing tests**, including:
  - `endpointUrl(getPreset('opencode-go')!, 'https://opencode.ai/inference/go/', 'chat_completions')` → `'https://opencode.ai/inference/go/openai/v1/chat/completions'`; `'models'` → `'.../go/v1/models'`.
  - `endpointUrl(getPreset('local')!, 'http://localhost:1234/v1', 'responses')` → `'http://localhost:1234/v1/responses'`.
  - `buildRequestBody('chat_completions', {model:'m', instructions:'I', input:'U', temperature:0.5, maxOutputTokens:100})` equals `{ model:'m', messages:[{role:'system',content:'I'},{role:'user',content:'U'}], temperature:0.5, max_tokens:100 }`.
  - `buildRequestBody('responses', …)` equals `{ model, instructions, input, temperature, max_output_tokens }`.
  - With `maxOutputTokens: 0`, neither body has `max_tokens`/`max_output_tokens`.
  - `buildHeaders(opencode-go, 'k', 'alice')` has `Authorization: 'Bearer k'`, `User-Agent` matching `/^narya\/\d/`, `x-opencode-session` of 32 hex chars, equal across two calls with `'alice'`, different for `'bob'`.
  - `buildHeaders(local, '', 'alice')` has no `Authorization` and no `x-opencode-session`.
  - `getPreset('nope')` → `null`; `isLlmApiFormat('anthropic')` → `false`.
- [ ] **Step 2:** `bun test src/server/llmProviders.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement.** Version from `package.json` via a JSON import; hash with `node:crypto` `createHash('sha256')`. `requiresApiKey`: true for opencode-go and openai.
- [ ] **Step 4:** Same command → PASS.
- [ ] **Step 5: Commit** `feat: add LLM provider presets and request builders`.

### Task 2: Storage and settings contract

**Files:**
- Modify: `src/server/db.ts` (create `llm_providers`; `addColumnIfMissing('llm_settings', 'active_provider', "text not null default 'local'")` + allowlist entries for column and table)
- Modify: `src/server/llm.ts` (settings read/save)
- Modify: `src/shared/api.ts` (`LlmSettings`, `LlmSettingsUpdate`, new `LlmProviderProfile`, `LlmModelList`)
- Test: `src/server/llmSettings.test.ts`

**Interfaces:**
- Consumes: Task 1 presets.
- Produces:
  - `LlmProviderProfile = { id: LlmProviderId; label: string; baseUrl: string; model: string; apiFormat: LlmApiFormat; apiKeyConfigured: boolean; requiresApiKey: boolean }`
  - `LlmSettings = { enabled; activeProvider: LlmProviderId; providers: LlmProviderProfile[]; personalityPrompt; temperature; maxOutputTokens; timeoutMs; updatedAt }` (no top-level baseUrl/model/apiKeyConfigured)
  - `LlmSettingsUpdate = { enabled; activeProvider: LlmProviderId; provider: { baseUrl: string; model: string; apiFormat: LlmApiFormat; apiKey?: string; clearApiKey?: boolean }; personalityPrompt; temperature; maxOutputTokens; timeoutMs }` — `provider` is the profile for `activeProvider`.
  - `LlmModelList = { ok: true; models: string[] } | { ok: false; error: string }`
  - in `llm.ts`: `getActiveProviderRow(): { preset: LlmProviderPreset; baseUrl: string; model: string; apiFormat: LlmApiFormat; apiKey: string }` and `getProviderRow(id: LlmProviderId)` (same shape), used by Task 3.

Table: `llm_providers (id text primary key, base_url text not null, api_key text not null default '', model text not null default '', api_format text not null, updated_at text not null)`. Rows are `insert or ignore`d from preset defaults on read.

- [ ] **Step 1: Write failing tests** (in-memory DB under `bun test`):
  - Fresh `getLlmSettings()` → `activeProvider === 'local'`, four providers in preset order, opencode-go `baseUrl` = Go base, `apiFormat` = `chat_completions`, all `apiKeyConfigured` false.
  - `saveLlmSettings({... activeProvider:'opencode-go', provider:{ baseUrl, model:'kimi-k3', apiFormat:'chat_completions', apiKey:'sk-go' }})` → active is opencode-go, its `apiKeyConfigured` true, `local` still false; `JSON.stringify(result)` does not contain `'sk-go'`.
  - Switch to `local` and back to `opencode-go` with no `apiKey` → opencode-go key still configured, model still `kimi-k3`.
  - `clearApiKey: true` → `apiKeyConfigured` false.
  - `activeProvider: 'nope'` → throws `HttpRouteError` 400; invalid `apiFormat` → 400; non-http base URL → 400 (existing message).
- [ ] **Step 2:** `bun test src/server/llmSettings.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Keep the existing shared-field validation; `ensureLlmSettings` unchanged. `runLlmRequest`'s "needs a base URL and model" guard now reads the active profile.
- [ ] **Step 4:** Same command → PASS; `bun test src/server/llm` → PASS.
- [ ] **Step 5: Commit** `feat: store LLM settings as per-provider profiles`.

### Task 3: Transport, session key, and models route

**Files:**
- Modify: `src/server/llm.ts` (`callLlm`, `runLlmRequest`, new `listProviderModels`, new route)
- Modify: `src/server/actionExecutor.ts:68,292` (pass conversation key)
- Test: `src/server/llmTransport.test.ts`

**Interfaces:**
- Consumes: Task 1 builders, Task 2 `getActiveProviderRow`/`getProviderRow`.
- Produces:
  - `runLlmRequest(instructions: string, input: string, conversationKey?: string): Promise<string>` (default `'anonymous'`)
  - executor `askLlm?: (instructions: string, input: string, conversationKey?: string) => Promise<string>`; call site passes `login ?? 'anonymous'`.
  - `listProviderModels(id: LlmProviderId, fetchImpl = fetch): Promise<LlmModelList>` — GETs `endpointUrl(preset, baseUrl, 'models')` with `buildHeaders(preset, key, 'models')`, timeout = settings `timeoutMs`, returns sorted unique `data[].id` strings.
  - Route `GET /api/llm/providers/:id/models` → 404 for unknown id, else 200 with `LlmModelList`. Operator-only (same guard as the other `/api/llm` routes — confirm nothing extra is needed in `auth.ts`).

- [ ] **Step 1: Write failing tests** stubbing `globalThis.fetch` (restore in `afterEach`):
  - Active opencode-go profile, `runLlmRequest('I','U','alice')` → fetch URL `https://opencode.ai/inference/go/openai/v1/chat/completions`, body has `messages`, headers include `x-opencode-session`; reply `{choices:[{message:{content:'hi'}}]}` → `'hi'`.
  - Active local profile with format `responses` → URL ends `/responses`, body has `instructions`.
  - `listProviderModels('opencode-go')` with `{data:[{id:'kimi-k3'},{id:'glm-5.3'}]}` → `{ok:true, models:['glm-5.3','kimi-k3']}`.
  - Fetch rejects → `{ok:false}` with error string; 401 response → `{ok:false}` with status in error; body `'<html>'` → `{ok:false}`; `{}` (no `data`) → `{ok:false}`.
- [ ] **Step 2:** `bun test src/server/llmTransport.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Keep error-detail parsing from the current `callLlm`. Test route uses conversation key `settings-test`.
- [ ] **Step 4:** `bun test` (full suite) → PASS; `bun run typecheck` → clean.
- [ ] **Step 5: Commit** `feat: route LLM calls through the active provider profile`.

### Task 4: Settings UI

**Files:**
- Modify: `src/client/services/dashboard.ts` (add `getLlmProviderModels(id: LlmProviderId): Promise<LlmModelList>`)
- Modify: `src/client/pages/settings/LlmSection.tsx`

**Interfaces:**
- Consumes: Task 2 contract types; Task 3 route.

- [ ] **Step 1: Implement the form.** Form state holds `activeProvider`, all `providers` (from server), per-provider edit drafts `{ baseUrl, model, apiFormat, apiKey, clearApiKey }`, and shared fields. Layout per the spec sketch: Provider select (labels from profiles) → Base URL → API key (placeholder "Configured - leave blank to keep" / "Required" / "Optional") + clear checkbox → Format select (Responses / Chat Completions) → Model input with `list="llm-models"` datalist and a status line → existing shared fields → test panel → Save. Saving sends `activeProvider` and the draft for that provider.
- [ ] **Step 2: Auto-load models.** Effect keyed on `(activeProvider, saved baseUrl, apiKeyConfigured)` of the *saved* profile: run when loaded, on provider switch, and after a successful save, only if the saved profile has a base URL and (`!requiresApiKey || apiKeyConfigured`). Ignore stale responses (compare provider id/sequence). Status: "Loading models…", "N models loaded", or "Couldn't load models: <error>". Update the example line under the form to name the active preset instead of hard-coding LM Studio.
- [ ] **Step 3:** `bun run typecheck && bun run build` → clean.
- [ ] **Step 4: Browser check** against a scratch DB on a free port (`STREAMER_TOOLS_DB=$CLAUDE_JOB_DIR/tmp/llm.sqlite PORT=<free> bun run dev`, Vite on another free port; do not use the operator's Chrome token flow — use the dev server's token from the env of that command). Verify: dropdown switches fields; Local with nothing running shows the "Couldn't load models" note and the field stays editable; save persists across reload; no key in network GET responses.
- [ ] **Step 5: Commit** `feat: add provider picker and model loading to LLM settings`.
