# LLM Action Step Context, Targeting, and Declining — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the `llm_response` Action step a per-step system prompt, chat and interaction context, few-shot examples, viewer-tag targeting, an opt-out reply contract, and a mention toggle.

**Architecture:** Prompt assembly and reply parsing move into a new pure module (`llmPrompt.ts`) with no DB or `fetch`, so they are unit-testable. Everything the executor needs from the database — viewer tags, chat lines, interaction memory — arrives through injected ports, matching the existing `resolveMedia` seam. Back-compat is handled once at the DB read boundary (`rowToStep`) rather than defensively throughout the executor.

**Tech Stack:** Bun, TypeScript (strict), React 18, SQLite (`bun:sqlite`), Express.

## Global Constraints

- TypeScript strict mode. No linter or formatter — match existing two-space indentation.
- Client/server contracts live in `src/shared/api.ts`. Never duplicate payload interfaces.
- Tests are `*.test.ts` colocated with source. `bun test` sets `NODE_ENV=test`, giving an in-memory DB.
- **Never verify against the real database from an ad-hoc script.** `db.ts` resolves its path at import time and ES imports are hoisted. Put checks in `*.test.ts`.
- Commits use semantic prefixes: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`.
- Limits are tested with **violating** values, never defaults. A clamp asserted by calling it with its own default passes even when the clamp is deleted.
- ~21 media-asset tests fail in a git worktree because `public/clips` and `public/sounds` are gitignored. That is pre-existing, not a regression.
- Spec: `docs/superpowers/specs/2026-07-20-llm-action-context-design.md`.

---

### Task 1: Shared viewer-tag normalization and gating

`normalizeProfileTag` and `addProfileTag` currently live in `src/client/ui/panels.tsx` — client-only. The server has never normalized a tag, so a gate configured `no-llm` would not match a tag saved `No-LLM`, and it would fail **open** and silently. Note `normalizeProfileTag` preserves case; `addProfileTag` dedupes case-insensitively. The gate must therefore compare lowercased.

**Files:**
- Create: `src/shared/viewerTags.ts`
- Create: `src/shared/viewerTags.test.ts`
- Modify: `src/client/ui/panels.tsx:64` (remove `MAX_VIEWER_TAGS`), `:271-281` (remove both helpers), add import

**Interfaces:**
- Produces: `MAX_VIEWER_TAGS: number`, `normalizeProfileTag(value: string): string`, `addProfileTag(tags: string[], value: string): string[]`, `tagGateAllows(viewerTags: string[], allowTags: string[], denyTags: string[]): boolean`

- [ ] **Step 1: Write the failing test**

Create `src/shared/viewerTags.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { addProfileTag, MAX_VIEWER_TAGS, normalizeProfileTag, tagGateAllows } from './viewerTags';

test('normalizeProfileTag strips a leading hash and surrounding space, preserving case', () => {
  expect(normalizeProfileTag('  #No-LLM ')).toBe('No-LLM');
});

test('normalizeProfileTag caps length at 32 characters', () => {
  expect(normalizeProfileTag('x'.repeat(50))).toHaveLength(32);
});

test('addProfileTag dedupes case-insensitively', () => {
  expect(addProfileTag(['No-LLM'], 'no-llm')).toEqual(['No-LLM']);
});

test('addProfileTag refuses to exceed MAX_VIEWER_TAGS', () => {
  const full = Array.from({ length: MAX_VIEWER_TAGS }, (_, i) => `tag${i}`);
  expect(addProfileTag(full, 'one-more')).toEqual(full);
});

test('an empty allow list admits everyone', () => {
  expect(tagGateAllows([], [], [])).toBe(true);
  expect(tagGateAllows(['artist'], [], [])).toBe(true);
});

test('deny beats allow', () => {
  expect(tagGateAllows(['vip', 'no-llm'], ['vip'], ['no-llm'])).toBe(false);
});

test('the gate matches regardless of case', () => {
  expect(tagGateAllows(['No-LLM'], [], ['no-llm'])).toBe(false);
  expect(tagGateAllows(['no-llm'], [], ['No-LLM'])).toBe(false);
});

test('an allow list rejects a viewer carrying none of its tags', () => {
  expect(tagGateAllows(['artist'], ['vip'], [])).toBe(false);
});

test('an allow list rejects an invocation with no tags at all', () => {
  // A module-lifecycle or manual run has no login and therefore no tags. "Only these
  // tags may use this" does not describe an anonymous invocation.
  expect(tagGateAllows([], ['vip'], [])).toBe(false);
});

test('a deny list admits an invocation with no tags', () => {
  expect(tagGateAllows([], [], ['no-llm'])).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/shared/viewerTags.test.ts`
Expected: FAIL — `Cannot find module './viewerTags'`

- [ ] **Step 3: Write the implementation**

Create `src/shared/viewerTags.ts`:

```ts
/**
 * Viewer profile tags, shared by the Viewer Profile modal, the LLM step's targeting
 * editors, and the server-side gate that enforces them.
 *
 * Normalization deliberately PRESERVES case — the operator's own capitalization is
 * part of the label they see. Every comparison therefore lowercases explicitly; a
 * gate that compared raw strings would let a tag saved "No-LLM" slip past a rule
 * written "no-llm", and it would fail open and silently.
 */

export const MAX_VIEWER_TAGS = 12;

const MAX_TAG_LENGTH = 32;

export function normalizeProfileTag(value: string): string {
  return value.trim().replace(/^#/, '').slice(0, MAX_TAG_LENGTH);
}

export function addProfileTag(tags: string[], value: string): string[] {
  const tag = normalizeProfileTag(value);
  if (!tag || tags.length >= MAX_VIEWER_TAGS) return tags;
  const existing = new Set(tags.map(item => item.toLowerCase()));
  if (existing.has(tag.toLowerCase())) return tags;
  return [...tags, tag];
}

/**
 * Deny beats allow, and an empty allow list admits everyone.
 *
 * An invocation with no tags — no login, so no profile — passes a deny list but is
 * REJECTED by an allow list. That asymmetry is deliberate: "only these tags" does not
 * describe an anonymous run.
 */
export function tagGateAllows(viewerTags: string[], allowTags: string[], denyTags: string[]): boolean {
  const held = new Set(viewerTags.map(tag => normalizeProfileTag(tag).toLowerCase()).filter(Boolean));
  const deny = denyTags.map(tag => normalizeProfileTag(tag).toLowerCase()).filter(Boolean);
  if (deny.some(tag => held.has(tag))) return false;
  const allow = allowTags.map(tag => normalizeProfileTag(tag).toLowerCase()).filter(Boolean);
  if (allow.length === 0) return true;
  return allow.some(tag => held.has(tag));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/shared/viewerTags.test.ts`
Expected: PASS, 9 tests

- [ ] **Step 5: Point `panels.tsx` at the shared module**

In `src/client/ui/panels.tsx`, delete the local `const MAX_VIEWER_TAGS = 12;` (line 64) and the `normalizeProfileTag` / `addProfileTag` function declarations (lines ~271–281). Add to the existing import block near the top:

```ts
import { addProfileTag, MAX_VIEWER_TAGS, normalizeProfileTag } from '../../shared/viewerTags';
```

- [ ] **Step 6: Verify nothing else referenced the removed symbols**

Run: `bun run typecheck`
Expected: no errors. If `MAX_VIEWER_TAGS` is reported unused anywhere, it is still used at `panels.tsx:689-690` — confirm the import landed.

- [ ] **Step 7: Commit**

```bash
git add src/shared/viewerTags.ts src/shared/viewerTags.test.ts src/client/ui/panels.tsx
git commit -m "refactor: move viewer tag helpers to shared and add a gate predicate"
```

---

### Task 2: Payload contract and read-boundary defaults

`rowToStep` (`src/server/actions.ts:359`) parses `payload_json` and blind-casts it to the step union. Every stored `llm_response` row is `{ template }`, so on the day this ships every new field arrives `undefined` while the type asserts otherwise. Default **here**, once, so the union stays honest and the executor never needs `?? false`.

**Files:**
- Modify: `src/shared/api.ts:845` (`LlmResponsePayload`)
- Modify: `src/server/actions.ts:191-192` (`normalizeStepPayload`), `:359-376` (`rowToStep`)
- Create: `src/server/llmStepPayload.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `LlmSystemPromptMode`, `LlmExample`, extended `LlmResponsePayload` (all from `src/shared/api.ts`); `DEFAULT_LLM_PAYLOAD` and `withLlmPayloadDefaults(payload: unknown): LlmResponsePayload` exported from `src/server/actions.ts`.

- [ ] **Step 1: Write the failing test**

Create `src/server/llmStepPayload.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { withLlmPayloadDefaults } from './actions';

test('a legacy payload keeps its template and gains every new field', () => {
  const filled = withLlmPayloadDefaults({ template: 'Answer {actor}' });
  expect(filled.template).toBe('Answer {actor}');
  expect(filled.systemPrompt).toBe('');
  expect(filled.systemPromptMode).toBe('enhance');
  expect(filled.chatHistoryLines).toBe(0);
  expect(filled.interactionHistory).toBe(0);
  expect(filled.examples).toEqual([]);
  expect(filled.allowTags).toEqual([]);
  expect(filled.denyTags).toEqual([]);
  expect(filled.allowDecline).toBe(false);
});

test('mention defaults to true so existing steps keep their @mention', () => {
  // formatPonderReply prefixes @displayName unconditionally today. Defaulting this to
  // false would silently strip the mention from every step the operator already has.
  expect(withLlmPayloadDefaults({ template: 'x' }).mention).toBe(true);
});

test('stored values win over defaults', () => {
  const filled = withLlmPayloadDefaults({
    template: 'x',
    systemPrompt: 'Be terse.',
    systemPromptMode: 'override',
    chatHistoryLines: 10,
    interactionHistory: 3,
    examples: [{ input: 'hi', output: 'hello' }],
    allowTags: ['vip'],
    denyTags: ['no-llm'],
    allowDecline: true,
    mention: false,
  });
  expect(filled.systemPrompt).toBe('Be terse.');
  expect(filled.systemPromptMode).toBe('override');
  expect(filled.chatHistoryLines).toBe(10);
  expect(filled.interactionHistory).toBe(3);
  expect(filled.examples).toEqual([{ input: 'hi', output: 'hello' }]);
  expect(filled.allowTags).toEqual(['vip']);
  expect(filled.denyTags).toEqual(['no-llm']);
  expect(filled.allowDecline).toBe(true);
  expect(filled.mention).toBe(false);
});

test('a corrupt mode falls back to enhance rather than propagating garbage', () => {
  expect(withLlmPayloadDefaults({ template: 'x', systemPromptMode: 'nonsense' }).systemPromptMode).toBe('enhance');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/server/llmStepPayload.test.ts`
Expected: FAIL — `withLlmPayloadDefaults is not a function`

- [ ] **Step 3: Extend the shared contract**

In `src/shared/api.ts`, replace `export type LlmResponsePayload = { template: string };` (line 845) with:

```ts
/** How a step's own system prompt combines with the global personality prompt. */
export type LlmSystemPromptMode = 'enhance' | 'override';

/** An operator-written few-shot pair, used to lock in voice and format. */
export type LlmExample = { input: string; output: string };

/**
 * `mention` exists because retiring the `!ponder` framing also retires
 * formatPonderReply, which prefixed `@displayName` unconditionally. Stored rows
 * predate every field below `template`, so they are defaulted at the read boundary
 * (withLlmPayloadDefaults) — and `mention` defaults to TRUE to preserve that
 * behaviour.
 *
 * `chatHistoryLines` and `interactionHistory` are counts, not a token budget: there
 * is no tokenizer for whatever model sits behind the configured base URL, so a byte
 * budget would be a guess presented as a guarantee. Their caps exist to stop a typo
 * from hanging a live stream, not to manage a context window.
 */
export type LlmResponsePayload = {
  template: string;
  systemPrompt: string;
  systemPromptMode: LlmSystemPromptMode;
  chatHistoryLines: number;
  interactionHistory: number;
  examples: LlmExample[];
  allowTags: string[];
  denyTags: string[];
  allowDecline: boolean;
  mention: boolean;
};

/** Caps for an llm_response payload. Mirrored in settings/automation.ts. */
export const MAX_LLM_CHAT_HISTORY_LINES = 50;
export const MAX_LLM_INTERACTION_HISTORY = 20;
export const MAX_LLM_EXAMPLES = 10;
export const MAX_LLM_EXAMPLE_LENGTH = 500;
export const MAX_LLM_SYSTEM_PROMPT_LENGTH = 2000;
export const MAX_LLM_GATE_TAGS = 20;
```

- [ ] **Step 4: Add the read-boundary defaults**

In `src/server/actions.ts`, add near the top-level helpers (after the `COUNTER_MODES` constant around line 47):

```ts
const LLM_MODES = new Set<LlmSystemPromptMode>(['enhance', 'override']);

/**
 * rowToStep blind-casts parsed payload JSON to the step union, so a stored row that
 * predates a field yields `undefined` while the type claims otherwise. Filling the
 * gaps HERE keeps the union honest and puts the defaults in one place instead of
 * scattering `?? false` through the executor.
 */
export function withLlmPayloadDefaults(payload: unknown): LlmResponsePayload {
  const value = (payload ?? {}) as Partial<LlmResponsePayload>;
  const mode = typeof value.systemPromptMode === 'string' && LLM_MODES.has(value.systemPromptMode as LlmSystemPromptMode)
    ? value.systemPromptMode as LlmSystemPromptMode
    : 'enhance';
  const count = (raw: unknown): number =>
    typeof raw === 'number' && Number.isFinite(raw) ? Math.max(0, Math.round(raw)) : 0;
  const strings = (raw: unknown): string[] =>
    Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : [];

  return {
    template: typeof value.template === 'string' ? value.template : '',
    systemPrompt: typeof value.systemPrompt === 'string' ? value.systemPrompt : '',
    systemPromptMode: mode,
    chatHistoryLines: count(value.chatHistoryLines),
    interactionHistory: count(value.interactionHistory),
    examples: Array.isArray(value.examples)
      ? value.examples.filter((item): item is LlmExample =>
          Boolean(item) && typeof (item as LlmExample).input === 'string' && typeof (item as LlmExample).output === 'string')
      : [],
    allowTags: strings(value.allowTags),
    denyTags: strings(value.denyTags),
    allowDecline: value.allowDecline === true,
    // TRUE, not false: today's formatPonderReply always mentions.
    mention: value.mention !== false,
  };
}
```

Add `LlmExample`, `LlmResponsePayload`, and `LlmSystemPromptMode` to the existing `import type { … } from '../shared/api';` block at the top of the file.

- [ ] **Step 5: Apply the defaults in `rowToStep`**

In `src/server/actions.ts`, inside `rowToStep` (line ~359), after the `JSON.parse` try/catch and before the `return`, add:

```ts
  // llm_response rows predate every field but `template`; fill them here so the
  // union the executor receives is complete.
  if (row.stepType === 'llm_response') payload = withLlmPayloadDefaults(payload);
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test src/server/llmStepPayload.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 7: Validate the payload on the write path**

In `src/server/actions.ts`, replace the `case 'llm_response':` arm of `normalizeStepPayload` (lines 191–192) with:

```ts
    case 'llm_response': {
      const template = requireTemplate(value.template, 'LLM steps need a prompt.');
      const filled = withLlmPayloadDefaults({ ...value, template });

      if (filled.systemPrompt.length > MAX_LLM_SYSTEM_PROMPT_LENGTH) {
        throw new HttpRouteError(400, `LLM system prompts must be ${MAX_LLM_SYSTEM_PROMPT_LENGTH} characters or fewer.`);
      }
      if (filled.chatHistoryLines > MAX_LLM_CHAT_HISTORY_LINES) {
        throw new HttpRouteError(400, `LLM steps can include at most ${MAX_LLM_CHAT_HISTORY_LINES} chat lines.`);
      }
      if (filled.interactionHistory > MAX_LLM_INTERACTION_HISTORY) {
        throw new HttpRouteError(400, `LLM steps can replay at most ${MAX_LLM_INTERACTION_HISTORY} prior interactions.`);
      }
      if (filled.examples.length > MAX_LLM_EXAMPLES) {
        throw new HttpRouteError(400, `LLM steps can carry at most ${MAX_LLM_EXAMPLES} examples.`);
      }
      if (filled.examples.some(pair => pair.input.length > MAX_LLM_EXAMPLE_LENGTH || pair.output.length > MAX_LLM_EXAMPLE_LENGTH)) {
        throw new HttpRouteError(400, `LLM example text must be ${MAX_LLM_EXAMPLE_LENGTH} characters or fewer.`);
      }

      const gateTags = (tags: string[]): string[] => {
        const cleaned = tags.map(normalizeProfileTag).filter(Boolean);
        if (cleaned.length > MAX_LLM_GATE_TAGS) {
          throw new HttpRouteError(400, `LLM tag lists can hold at most ${MAX_LLM_GATE_TAGS} tags.`);
        }
        return cleaned;
      };

      return {
        ...filled,
        allowTags: gateTags(filled.allowTags),
        denyTags: gateTags(filled.denyTags),
      };
    }
```

Add to the imports at the top of `src/server/actions.ts`:

```ts
import { normalizeProfileTag } from '../shared/viewerTags';
```

and add `MAX_LLM_CHAT_HISTORY_LINES`, `MAX_LLM_EXAMPLE_LENGTH`, `MAX_LLM_EXAMPLES`, `MAX_LLM_GATE_TAGS`, `MAX_LLM_INTERACTION_HISTORY`, `MAX_LLM_SYSTEM_PROMPT_LENGTH` to the value import from `../shared/api`.

- [ ] **Step 8: Test the caps with violating values**

Append to `src/server/llmStepPayload.test.ts`:

```ts
import { normalizeStepPayloadForTest } from './actions';

test('a system prompt over the cap is rejected', () => {
  expect(() => normalizeStepPayloadForTest('llm_response', {
    template: 'x',
    systemPrompt: 'y'.repeat(2001),
  })).toThrow(/2000 characters or fewer/);
});

test('too many chat lines is rejected', () => {
  expect(() => normalizeStepPayloadForTest('llm_response', {
    template: 'x',
    chatHistoryLines: 51,
  })).toThrow(/at most 50 chat lines/);
});

test('too many replayed interactions is rejected', () => {
  expect(() => normalizeStepPayloadForTest('llm_response', {
    template: 'x',
    interactionHistory: 21,
  })).toThrow(/at most 20 prior interactions/);
});

test('too many examples is rejected', () => {
  expect(() => normalizeStepPayloadForTest('llm_response', {
    template: 'x',
    examples: Array.from({ length: 11 }, () => ({ input: 'a', output: 'b' })),
  })).toThrow(/at most 10 examples/);
});

test('an over-long example side is rejected', () => {
  expect(() => normalizeStepPayloadForTest('llm_response', {
    template: 'x',
    examples: [{ input: 'a'.repeat(501), output: 'b' }],
  })).toThrow(/500 characters or fewer/);
});

test('too many gate tags is rejected', () => {
  expect(() => normalizeStepPayloadForTest('llm_response', {
    template: 'x',
    denyTags: Array.from({ length: 21 }, (_, i) => `tag${i}`),
  })).toThrow(/at most 20 tags/);
});

test('gate tags are normalized on the way in', () => {
  const saved = normalizeStepPayloadForTest('llm_response', {
    template: 'x',
    denyTags: [' #No-LLM ', ''],
  }) as { denyTags: string[] };
  expect(saved.denyTags).toEqual(['No-LLM']);
});
```

Export the normalizer for tests. In `src/server/actions.ts`, immediately after the `normalizeStepPayload` function declaration add:

```ts
/** Test seam: normalizeStepPayload is module-private but its limits need direct cover. */
export const normalizeStepPayloadForTest = normalizeStepPayload;
```

- [ ] **Step 9: Run the tests**

Run: `bun test src/server/llmStepPayload.test.ts`
Expected: PASS, 11 tests

- [ ] **Step 10: Mutation-check one cap**

Temporarily change `MAX_LLM_CHAT_HISTORY_LINES` in `src/shared/api.ts` to `9999`, run `bun test src/server/llmStepPayload.test.ts`, and confirm the "too many chat lines" test **fails**. Restore `50` and confirm it passes again. This proves the cap is enforced rather than coincidentally satisfied.

- [ ] **Step 11: Commit**

```bash
git add src/shared/api.ts src/server/actions.ts src/server/llmStepPayload.test.ts
git commit -m "feat: extend the llm_response payload with context, targeting, and reply options"
```

---

### Task 3: Interaction memory

Keyed by login alone — there is one bot, so its memory of a person spans commands.

**Files:**
- Modify: `src/server/db.ts` (new table + index, alongside the other `create table if not exists` statements)
- Create: `src/server/llmContext.ts`
- Create: `src/server/llmContext.test.ts`
- Modify: `src/server/viewerIdentity.ts` (`flushViewer`), `src/server/viewers.ts:159-160` (route), `src/shared/api.ts` (`ViewerFlushResult`)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `recordInteraction(login: string, prompt: string, reply: string): void`, `loadInteractions(login: string, limit: number): LlmInteractionTurn[]`, `deleteInteractionsForLogin(login: string): number`, `recentChatLines(limit: number): LlmChatLine[]` (added in Task 5), `MAX_STORED_INTERACTIONS: number`, and the types `LlmInteractionTurn = { prompt: string; reply: string }` and `LlmChatLine = { display: string; message: string }` — all from `src/server/llmContext.ts`.

> **Why this module exists rather than putting these reads in `chat.ts`.**
> `chat.ts` imports `automation.ts`, which imports `actionExecutor.ts`. Having the
> executor import `chat.ts` would close the loop `actionExecutor → chat → automation →
> actionExecutor`, and all three prepare statements or build objects at load time — so
> it fails as a boot-order crash rather than a clean error. That is the same trap
> `windDown.ts` documents. `llmContext.ts` imports only `db.ts`, so it has no path back.
> For the same reason **both** context types are declared here and `llmPrompt.ts`
> imports them, never the reverse.

- [ ] **Step 1: Add the schema**

In `src/server/db.ts`, alongside the other table definitions (after the `quote_sequence` block around line 507):

```sql
  create table if not exists llm_interactions (
    id text primary key,
    login text not null,
    prompt text not null,
    reply text not null,
    created_at text not null
  );
```

And after the `db.exec` block containing it:

```ts
db.exec('create index if not exists idx_llm_interactions_login on llm_interactions(login, created_at)');
```

- [ ] **Step 2: Write the failing test**

Create `src/server/llmContext.test.ts`:

```ts
import { beforeEach, expect, test } from 'bun:test';
import { db } from './db';
import { deleteInteractionsForLogin, loadInteractions, MAX_STORED_INTERACTIONS, recordInteraction } from './llmContext';

beforeEach(() => {
  db.exec('delete from llm_interactions');
});

test('an interaction round-trips', () => {
  recordInteraction('bob', 'why lurk', 'because rest is good');
  expect(loadInteractions('bob', 5)).toEqual([{ prompt: 'why lurk', reply: 'because rest is good' }]);
});

test('interactions come back oldest first so they read as a transcript', () => {
  recordInteraction('bob', 'first', 'one');
  recordInteraction('bob', 'second', 'two');
  recordInteraction('bob', 'third', 'three');
  expect(loadInteractions('bob', 5).map(turn => turn.prompt)).toEqual(['first', 'second', 'third']);
});

test('the limit takes the NEWEST turns, not the oldest', () => {
  recordInteraction('bob', 'first', 'one');
  recordInteraction('bob', 'second', 'two');
  recordInteraction('bob', 'third', 'three');
  expect(loadInteractions('bob', 2).map(turn => turn.prompt)).toEqual(['second', 'third']);
});

test('one viewer never sees another viewer turns', () => {
  recordInteraction('bob', 'bob asked', 'bob answered');
  recordInteraction('sue', 'sue asked', 'sue answered');
  expect(loadInteractions('bob', 5)).toEqual([{ prompt: 'bob asked', reply: 'bob answered' }]);
});

test('a zero limit reads nothing', () => {
  recordInteraction('bob', 'x', 'y');
  expect(loadInteractions('bob', 0)).toEqual([]);
});

test('storage is pruned to the cap on insert', () => {
  for (let i = 0; i < MAX_STORED_INTERACTIONS + 10; i += 1) {
    recordInteraction('bob', `prompt ${i}`, `reply ${i}`);
  }
  const stored = db.prepare('select count(*) as count from llm_interactions where login = ?').get('bob') as { count: number };
  expect(stored.count).toBe(MAX_STORED_INTERACTIONS);
  // Pruning must drop the OLDEST, so the newest turn survives.
  expect(loadInteractions('bob', 1)[0]!.prompt).toBe(`prompt ${MAX_STORED_INTERACTIONS + 9}`);
});

test('an empty login is neither stored nor read', () => {
  recordInteraction('', 'x', 'y');
  expect(db.prepare('select count(*) as count from llm_interactions').get()).toEqual({ count: 0 });
  expect(loadInteractions('', 5)).toEqual([]);
});

test('deleting by login reports how many rows went', () => {
  recordInteraction('bob', 'a', 'b');
  recordInteraction('bob', 'c', 'd');
  recordInteraction('sue', 'e', 'f');
  expect(deleteInteractionsForLogin('bob')).toBe(2);
  expect(loadInteractions('sue', 5)).toHaveLength(1);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test src/server/llmContext.test.ts`
Expected: FAIL — `Cannot find module './llmContext'`

- [ ] **Step 4: Write the implementation**

Create `src/server/llmContext.ts`:

```ts
import { db } from './db';

/**
 * What the bot and a viewer have said to each other, keyed by login alone. There is
 * one bot, so its memory of a person spans commands: a viewer who asks something under
 * one command and follows up under another is having a single conversation.
 *
 * Rows are written only AFTER the reply reaches chat (see actionExecutor) — the same
 * rule quote_show applies to shown_count. Recording an undelivered reply would make the
 * model's account of the conversation diverge from the room's.
 */
export type LlmInteractionTurn = { prompt: string; reply: string };

/** One line of channel chat. Declared here, not in llmPrompt.ts, so the dependency
 *  runs one way: llmPrompt imports llmContext and never the reverse. */
export type LlmChatLine = { display: string; message: string };

/** Only the newest handful are ever read, so unbounded growth buys nothing. */
export const MAX_STORED_INTERACTIONS = 50;

const insertInteraction = db.prepare(`
  insert into llm_interactions (id, login, prompt, reply, created_at)
  values (?, ?, ?, ?, ?)
`);

// Keyed on (login, created_at, id): created_at alone is not unique at this resolution,
// and two turns recorded in the same millisecond must still prune deterministically.
const pruneInteractions = db.prepare(`
  delete from llm_interactions
  where login = ?
    and id not in (
      select id from llm_interactions
      where login = ?
      order by created_at desc, id desc
      limit ?
    )
`);

const selectInteractions = db.prepare(`
  select prompt, reply
  from llm_interactions
  where login = ?
  order by created_at desc, id desc
  limit ?
`);

const deleteInteractions = db.prepare('delete from llm_interactions where login = ?');

const record = db.transaction((id: string, login: string, prompt: string, reply: string, now: string) => {
  insertInteraction.run(id, login, prompt, reply, now);
  pruneInteractions.run(login, login, MAX_STORED_INTERACTIONS);
});

export function recordInteraction(login: string, prompt: string, reply: string): void {
  const key = login.trim().toLowerCase();
  if (!key) return;
  record(crypto.randomUUID(), key, prompt, reply, new Date().toISOString());
}

/** Newest `limit` turns, returned OLDEST first so they read as a transcript. */
export function loadInteractions(login: string, limit: number): LlmInteractionTurn[] {
  const key = login.trim().toLowerCase();
  if (!key || limit <= 0) return [];
  const rows = selectInteractions.all(key, limit) as LlmInteractionTurn[];
  return rows.reverse();
}

export function deleteInteractionsForLogin(login: string): number {
  const key = login.trim().toLowerCase();
  if (!key) return 0;
  return (deleteInteractions.run(key) as { changes: number }).changes;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test src/server/llmContext.test.ts`
Expected: PASS, 8 tests

- [ ] **Step 6: Wire the flush**

This is viewer chat content — exactly what a flush exists to remove. Leaving it behind means a flushed viewer's words keep steering the bot's replies. Unlike quotes there is no circulating public identifier to preserve, so it is a delete, not an anonymize.

In `src/shared/api.ts`, add to `ViewerFlushResult` (line 541):

```ts
  /**
   * Recorded LLM exchanges deleted. Unlike quotes these are removed outright: there is
   * no public identifier in circulation to protect, and leaving them would let a
   * flushed viewer keep shaping the bot's replies.
   */
  interactionsRemoved: number;
```

In `src/server/viewerIdentity.ts`, import the deleter:

```ts
import { deleteInteractionsForLogin } from './llmContext';
```

then change `flushViewer`'s signature and body:

```ts
export function flushViewer(login: string, reason = ''): { messages: number; quotes: number; interactions: number } {
  const key = login.trim().toLowerCase();
  if (!key) return { messages: 0, quotes: 0, interactions: 0 };
  const now = new Date().toISOString();

  let messages = 0;
  let quotes = 0;
  let interactions = 0;
  db.transaction(() => {
    insertIgnored.run(key, reason, now);
    deleteChatter.run(key);
    deleteProfile.run(key);
    messages = (deleteMessages.run(key) as { changes: number }).changes;
    quotes = anonymizeQuotesByLogin(key);
    interactions = deleteInteractionsForLogin(key);
  })();

  return { messages, quotes, interactions };
}
```

Also extend the docstring above `flushViewer` with a sentence: `Recorded LLM interactions are deleted outright — see ViewerFlushResult.interactionsRemoved.`

In `src/server/viewers.ts`, update the route (lines 159–160):

```ts
    const { messages, quotes, interactions } = flushViewer(login, reason);
    response.json({
      login,
      messagesRemoved: messages,
      quotesAnonymized: quotes,
      interactionsRemoved: interactions,
    } satisfies ViewerFlushResult);
```

- [ ] **Step 7: Test the flush**

Append to `src/server/llmContext.test.ts`:

```ts
import { flushViewer } from './viewerIdentity';

test('flushing a viewer deletes their recorded interactions and reports the count', () => {
  db.exec("delete from ignored_logins where login = 'bob'");
  recordInteraction('bob', 'a', 'b');
  recordInteraction('bob', 'c', 'd');
  recordInteraction('sue', 'e', 'f');

  const result = flushViewer('bob');

  expect(result.interactions).toBe(2);
  expect(loadInteractions('bob', 5)).toEqual([]);
  // Another viewer's memory is untouched.
  expect(loadInteractions('sue', 5)).toHaveLength(1);
});
```

- [ ] **Step 8: Run the tests**

Run: `bun test src/server/llmContext.test.ts src/server/viewerIdentity.test.ts`
Expected: PASS. `viewerIdentity.test.ts` must still pass — if a call site there destructures `flushViewer`'s result, add `interactions` to it.

- [ ] **Step 9: Commit**

```bash
git add src/server/db.ts src/server/llmContext.ts src/server/llmContext.test.ts src/server/viewerIdentity.ts src/server/viewers.ts src/shared/api.ts
git commit -m "feat: record per-viewer LLM interactions and clear them on flush"
```

---

### Task 4: Prompt assembly and reply parsing

Pure functions — no DB, no `fetch` — so the whole assembly is testable without a server or a model.

**Files:**
- Create: `src/server/llmPrompt.ts`
- Create: `src/server/llmPrompt.test.ts`

**Interfaces:**
- Consumes: `LlmResponsePayload` (Task 2), `LlmChatLine` and `LlmInteractionTurn` (Task 3).
- Produces, from `src/server/llmPrompt.ts`:
  - `type LlmReply = { respond: boolean; message: string }`
  - `buildLlmRequest(input: { personalityPrompt: string; payload: LlmResponsePayload; context: TemplateContext; prompt: string; chatLines: LlmChatLine[]; interactions: LlmInteractionTurn[] }): { instructions: string; input: string }`
  - `parseLlmReply(raw: string, allowDecline: boolean): LlmReply`
  - `formatLlmReply(text: string, mentionName: string, mention: boolean): string`

- [ ] **Step 1: Write the failing test**

Create `src/server/llmPrompt.test.ts`:

```ts
import { expect, test } from 'bun:test';
import type { LlmResponsePayload, TemplateContext } from '../shared/api';
import { buildLlmRequest, formatLlmReply, parseLlmReply } from './llmPrompt';

const base: LlmResponsePayload = {
  template: '',
  systemPrompt: '',
  systemPromptMode: 'enhance',
  chatHistoryLines: 0,
  interactionHistory: 0,
  examples: [],
  allowTags: [],
  denyTags: [],
  allowDecline: false,
  mention: true,
};

function build(payload: Partial<LlmResponsePayload>, context: TemplateContext = {}, extra: {
  chatLines?: Array<{ display: string; message: string }>;
  interactions?: Array<{ prompt: string; reply: string }>;
} = {}) {
  return buildLlmRequest({
    personalityPrompt: 'You are Narya.',
    payload: { ...base, ...payload },
    context,
    prompt: 'Why do people lurk?',
    chatLines: extra.chatLines ?? [],
    interactions: extra.interactions ?? [],
  });
}

test('enhance appends the step prompt to the global personality', () => {
  const { instructions } = build({ systemPrompt: 'Be terse.', systemPromptMode: 'enhance' });
  expect(instructions).toContain('You are Narya.');
  expect(instructions).toContain('Be terse.');
  expect(instructions.indexOf('You are Narya.')).toBeLessThan(instructions.indexOf('Be terse.'));
});

test('override drops the global personality entirely', () => {
  const { instructions } = build({ systemPrompt: 'Be terse.', systemPromptMode: 'override' });
  expect(instructions).not.toContain('You are Narya.');
  expect(instructions).toContain('Be terse.');
});

test('an empty step prompt under override still yields usable instructions', () => {
  // Guards against emitting an empty system prompt, which some servers reject outright.
  const { instructions } = build({ systemPrompt: '', systemPromptMode: 'override' });
  expect(instructions.trim()).not.toBe('');
});

test('the rendered prompt is always present in the input', () => {
  expect(build({}).input).toContain('Why do people lurk?');
});

test('the actor block carries display name, login, role, and tags', () => {
  const { input } = build({}, { actor: 'Bob', login: 'bob', role: 'mod', tags: ['artist'] });
  expect(input).toContain('Bob');
  expect(input).toContain('@bob');
  expect(input).toContain('mod');
  expect(input).toContain('artist');
});

test('empty sections are omitted rather than emitted as empty headers', () => {
  const { input } = build({});
  expect(input).not.toContain('Recent chat');
  expect(input).not.toContain('Earlier in your conversation');
});

test('chat lines appear when requested, oldest first', () => {
  const { input } = build(
    { chatHistoryLines: 2 },
    {},
    { chatLines: [{ display: 'Ann', message: 'hi' }, { display: 'Bo', message: 'yo' }] },
  );
  expect(input).toContain('Recent chat');
  expect(input.indexOf('hi')).toBeLessThan(input.indexOf('yo'));
});

test('prior interactions appear when requested', () => {
  const { input } = build(
    { interactionHistory: 1 },
    {},
    { interactions: [{ prompt: 'earlier question', reply: 'earlier answer' }] },
  );
  expect(input).toContain('earlier question');
  expect(input).toContain('earlier answer');
});

test('examples land in the instructions, not the input', () => {
  const { instructions, input } = build({ examples: [{ input: 'ping', output: 'pong' }] });
  expect(instructions).toContain('ping');
  expect(instructions).toContain('pong');
  expect(input).not.toContain('pong');
});

test('the decline contract appears only when declining is allowed', () => {
  expect(build({ allowDecline: false }).instructions).not.toContain('"respond"');
  expect(build({ allowDecline: true }).instructions).toContain('"respond"');
});

// --- parseLlmReply ---

test('with declining off the raw text is the message', () => {
  expect(parseLlmReply('just words', false)).toEqual({ respond: true, message: 'just words' });
});

test('with declining off a JSON-looking reply is NOT unwrapped', () => {
  // The step never asked for JSON, so this is the model's literal answer.
  expect(parseLlmReply('{"respond": true, "message": "hi"}', false).message).toBe('{"respond": true, "message": "hi"}');
});

test('bare JSON is parsed', () => {
  expect(parseLlmReply('{"respond": true, "message": "hello"}', true)).toEqual({ respond: true, message: 'hello' });
});

test('fenced JSON is parsed', () => {
  const raw = '```json\n{"respond": true, "message": "hello"}\n```';
  expect(parseLlmReply(raw, true)).toEqual({ respond: true, message: 'hello' });
});

test('JSON with prose around it is parsed', () => {
  const raw = 'Sure! {"respond": true, "message": "hello"} Hope that helps.';
  expect(parseLlmReply(raw, true).message).toBe('hello');
});

test('respond:false is a decline', () => {
  expect(parseLlmReply('{"respond": false}', true).respond).toBe(false);
});

test('unparseable output falls through to the raw text rather than being swallowed', () => {
  // Local models fumble strict JSON regularly. Swallowing the reply would turn a
  // formatting quirk into a command that mysteriously stops working on stream.
  expect(parseLlmReply('I could not comply', true)).toEqual({ respond: true, message: 'I could not comply' });
});

test('valid JSON missing a message falls through to the raw text', () => {
  expect(parseLlmReply('{"respond": true}', true).message).toBe('{"respond": true}');
});

// --- formatLlmReply ---

test('mention prefixes the display name', () => {
  expect(formatLlmReply('hello', 'Bob', true)).toBe('@Bob hello');
});

test('mention off sends the reply bare', () => {
  expect(formatLlmReply('hello', 'Bob', false)).toBe('hello');
});

test('an empty mention name never yields a bare @', () => {
  expect(formatLlmReply('hello', '', true)).toBe('hello');
});

test('a reply over 500 characters is truncated with the mention counted in', () => {
  const long = 'x'.repeat(600);
  const out = formatLlmReply(long, 'Bob', true);
  expect(out.length).toBeLessThanOrEqual(500);
  expect(out.startsWith('@Bob ')).toBe(true);
  expect(out.endsWith('...')).toBe(true);
});

test('an over-long reply is truncated even without a mention', () => {
  expect(formatLlmReply('x'.repeat(600), '', false).length).toBeLessThanOrEqual(500);
});

test('whitespace is collapsed so a multi-line reply is a legal chat message', () => {
  expect(formatLlmReply('one\n\ntwo', '', false)).toBe('one two');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/server/llmPrompt.test.ts`
Expected: FAIL — `Cannot find module './llmPrompt'`

- [ ] **Step 3: Write the implementation**

Create `src/server/llmPrompt.ts`:

```ts
import type { LlmResponsePayload, TemplateContext } from '../shared/api';
import type { LlmChatLine, LlmInteractionTurn } from './llmContext';

export type LlmReply = { respond: boolean; message: string };

/** Twitch's per-message ceiling. */
const MAX_CHAT_LENGTH = 500;

const DECLINE_CONTRACT = [
  'Reply with a single JSON object and nothing else:',
  '{"respond": true, "message": "..."} to answer, or {"respond": false} to stay silent.',
  'Do not wrap it in code fences.',
].join(' ');

/** Used when override is selected but the step supplies no prompt of its own — some
 *  servers reject an empty instructions field outright. */
const FALLBACK_INSTRUCTIONS = 'You answer Twitch chat. Keep it to one short message.';

function joinSections(sections: string[]): string {
  return sections.filter(section => section.trim()).join('\n\n');
}

function actorBlock(context: TemplateContext): string {
  const display = context.actor ?? context.login ?? '';
  if (!display && !context.login) return '';
  const parts = [display];
  if (context.login) parts.push(`(@${context.login})`);
  const facts: string[] = [];
  if (context.role) facts.push(`roles: ${context.role}`);
  if (context.tags && context.tags.length > 0) facts.push(`tags: ${context.tags.join(', ')}`);
  return `Speaker: ${parts.join(' ')}${facts.length ? ` — ${facts.join(' — ')}` : ''}`;
}

function examplesBlock(payload: LlmResponsePayload): string {
  if (payload.examples.length === 0) return '';
  const pairs = payload.examples
    .map(pair => `Input: ${pair.input}\nOutput: ${pair.output}`)
    .join('\n\n');
  return `Answer in the style of these examples:\n\n${pairs}`;
}

function chatBlock(lines: LlmChatLine[]): string {
  if (lines.length === 0) return '';
  const body = lines.map(line => `${line.display}: ${line.message}`).join('\n');
  return `Recent chat, oldest first:\n${body}`;
}

function interactionBlock(turns: LlmInteractionTurn[]): string {
  if (turns.length === 0) return '';
  const body = turns.map(turn => `Them: ${turn.prompt}\nYou: ${turn.reply}`).join('\n');
  return `Earlier in your conversation with this person, oldest first:\n${body}`;
}

/**
 * `instructions` carries the durable contract (persona, examples, decline rules);
 * `input` carries the situational material in a fixed order, so a cached prefix stays
 * stable across invocations.
 *
 * The `!ponder` framing this replaced ("A Twitch chatter named X asks: …") is gone
 * deliberately. The actor block states the speaker's role, which is what lets an
 * operator's system prompt answer a moderator differently without any role branching
 * in code.
 */
export function buildLlmRequest(input: {
  personalityPrompt: string;
  payload: LlmResponsePayload;
  context: TemplateContext;
  prompt: string;
  chatLines: LlmChatLine[];
  interactions: LlmInteractionTurn[];
}): { instructions: string; input: string } {
  const { personalityPrompt, payload, context, prompt, chatLines, interactions } = input;

  const persona = payload.systemPromptMode === 'override'
    ? payload.systemPrompt
    : joinSections([personalityPrompt, payload.systemPrompt]);

  const instructions = joinSections([
    persona.trim() ? persona : FALLBACK_INSTRUCTIONS,
    examplesBlock(payload),
    payload.allowDecline ? DECLINE_CONTRACT : '',
  ]);

  return {
    instructions,
    input: joinSections([
      actorBlock(context),
      chatBlock(chatLines),
      interactionBlock(interactions),
      prompt,
    ]),
  };
}

/** Finds the first balanced `{…}` span, ignoring braces inside JSON strings. */
function firstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i]!;
    if (escaped) { escaped = false; continue; }
    if (char === '\\') { escaped = true; continue; }
    if (char === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * A model that cannot emit clean JSON still gets its answer through: unparseable
 * output falls through to the raw text. Swallowing it would turn a formatting quirk
 * into a command that mysteriously stops working mid-stream. The gate that carries
 * the safety weight is the tag deny-list, which never depends on model compliance.
 */
export function parseLlmReply(raw: string, allowDecline: boolean): LlmReply {
  if (!allowDecline) return { respond: true, message: raw };

  const candidate = firstJsonObject(raw.replace(/```[a-z]*\n?/gi, '').replace(/```/g, ''));
  if (!candidate) return { respond: true, message: raw };

  try {
    const parsed = JSON.parse(candidate) as { respond?: unknown; message?: unknown };
    if (parsed.respond === false) return { respond: false, message: '' };
    if (typeof parsed.message === 'string' && parsed.message.trim()) {
      return { respond: true, message: parsed.message };
    }
  } catch { /* fall through to the raw text */ }

  return { respond: true, message: raw };
}

/**
 * Collapses whitespace, optionally prefixes the mention, and truncates to Twitch's
 * 500-character ceiling. The mention counts toward the limit — a reply that overflows
 * because of the prefix is still an illegal chat message.
 */
export function formatLlmReply(text: string, mentionName: string, mention: boolean): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  const prefix = mention && mentionName ? `@${mentionName} ` : '';
  const full = `${prefix}${compact}`;
  if (full.length <= MAX_CHAT_LENGTH) return full;
  return `${full.slice(0, MAX_CHAT_LENGTH - 3).trimEnd()}...`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/server/llmPrompt.test.ts`
Expected: PASS, 23 tests

- [ ] **Step 5: Commit**

```bash
git add src/server/llmPrompt.ts src/server/llmPrompt.test.ts
git commit -m "feat: add pure LLM prompt assembly and reply parsing"
```

---

### Task 5: Chat-line source and the LLM call seam

The reader goes in `llmContext.ts`, **not** `chat.ts`. `chat.ts` imports `automation.ts` which imports `actionExecutor.ts`, so an executor import of `chat.ts` closes a load-time cycle and crashes at boot. `llmContext.ts` imports only `db.ts`. Reading `chat_messages` from a second module is already the norm here — `routes.ts:85` and `dashboard/status.ts:132` both do it.

`llm.ts` gains a function that takes an assembled request instead of building a `!ponder` frame.

**Files:**
- Modify: `src/server/llmContext.ts` (add `recentChatLines`)
- Modify: `src/server/llm.ts` (add `runLlmRequest` and `getPersonalityPrompt`, retire `askPonderLlm`)
- Modify: `src/server/llmContext.test.ts` (add the chat-line cases)

**Interfaces:**
- Consumes: `LlmChatLine` (Task 3).
- Produces: `recentChatLines(limit: number): LlmChatLine[]` from `src/server/llmContext.ts`; `runLlmRequest(instructions: string, input: string): Promise<string>` and `getPersonalityPrompt(): string` from `src/server/llm.ts`.

- [ ] **Step 1: Write the failing test**

Create `src/server/llmChatLines.test.ts` (its own file so its `beforeEach` does not collide with the interaction suite's):

```ts
import { beforeEach, expect, test } from 'bun:test';
import { db } from './db';
import { recentChatLines } from './llmContext';

function insert(id: string, username: string, message: string, receivedAt: string, deletedAt: string | null = null) {
  db.prepare(`
    insert into chat_messages (id, channel, username, display_name, color, message, received_at, deleted_at)
    values (?, 'test', ?, ?, null, ?, ?, ?)
  `).run(id, username, username, message, receivedAt, deletedAt);
}

beforeEach(() => {
  db.exec('delete from chat_messages');
});

test('lines come back oldest first', () => {
  insert('1', 'ann', 'first', '2026-07-20T10:00:00.000Z');
  insert('2', 'bo', 'second', '2026-07-20T10:00:01.000Z');
  expect(recentChatLines(5).map(line => line.message)).toEqual(['first', 'second']);
});

test('the limit takes the newest lines', () => {
  insert('1', 'ann', 'first', '2026-07-20T10:00:00.000Z');
  insert('2', 'bo', 'second', '2026-07-20T10:00:01.000Z');
  insert('3', 'cy', 'third', '2026-07-20T10:00:02.000Z');
  expect(recentChatLines(2).map(line => line.message)).toEqual(['second', 'third']);
});

test('a moderated message never reaches the prompt', () => {
  // Replaying a timed-out message into the model's context would resurrect exactly
  // the content moderation removed, and could put it back on stream in a reply.
  insert('1', 'ann', 'fine', '2026-07-20T10:00:00.000Z');
  insert('2', 'troll', 'removed', '2026-07-20T10:00:01.000Z', '2026-07-20T10:00:02.000Z');
  expect(recentChatLines(5).map(line => line.message)).toEqual(['fine']);
});

test('a zero limit reads nothing', () => {
  insert('1', 'ann', 'first', '2026-07-20T10:00:00.000Z');
  expect(recentChatLines(0)).toEqual([]);
});

test('the display name is preferred over the login', () => {
  db.prepare(`
    insert into chat_messages (id, channel, username, display_name, color, message, received_at, deleted_at)
    values ('1', 'test', 'ann', 'AnnTheGreat', null, 'hi', '2026-07-20T10:00:00.000Z', null)
  `).run();
  expect(recentChatLines(5)[0]!.display).toBe('AnnTheGreat');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/server/llmChatLines.test.ts`
Expected: FAIL — `recentChatLines is not a function`

- [ ] **Step 3: Add the reader**

In `src/server/llmContext.ts`, add below the interaction statements:

```ts
const selectRecentChatLines = db.prepare(`
  select coalesce(nullif(display_name, ''), username) as display, message
  from chat_messages
  where deleted_at is null
  order by received_at desc, id desc
  limit ?
`);

/**
 * Recent channel chat for an LLM step's context, oldest first.
 *
 * Soft-deleted rows are excluded deliberately: replaying a moderated message into the
 * model's context would resurrect exactly the content moderation removed, and could
 * put it back on stream inside a generated reply.
 */
export function recentChatLines(limit: number): LlmChatLine[] {
  if (limit <= 0) return [];
  const rows = selectRecentChatLines.all(limit) as LlmChatLine[];
  return rows.reverse();
}
```

No new import is needed — `LlmChatLine` is declared in this module (Task 3).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/server/llmChatLines.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Replace `askPonderLlm` with a request runner**

In `src/server/llm.ts`, change `callLlm` to take the instructions explicitly. Replace its signature and the `instructions` line:

```ts
async function callLlm(settings: LlmSettingsRow, instructions: string, userContent: string): Promise<string> {
```

and inside the `body: JSON.stringify({ … })`, replace `instructions: settings.personalityPrompt,` with `instructions,` and `input: userContent,` stays as is.

Update the two existing call sites in that file to pass `settings.personalityPrompt` as the new second argument.

Then replace the whole `askPonderLlm` function with:

```ts
/** The personality prompt an llm_response step enhances or overrides. */
export function getPersonalityPrompt(): string {
  return getSettingsRowOrDefault().personalityPrompt;
}

/**
 * Runs an already-assembled request. Prompt construction lives in llmPrompt.ts, which
 * is pure; this function owns only settings, transport, and failure text.
 *
 * Throws on a disabled or unconfigured LLM so the calling step reports a real status
 * rather than publishing an apology to chat as though it were an answer.
 */
export async function runLlmRequest(instructions: string, input: string): Promise<string> {
  const settings = getSettingsRowOrDefault();
  if (settings.enabled !== 1) throw new Error('The LLM is disabled in Settings.');
  if (!settings.baseUrl || !settings.model) throw new Error('The LLM needs a base URL and model in Settings.');
  return callLlm(settings, instructions, input);
}
```

Delete `formatPonderReply`, `userContent`, and `mention` from `llm.ts` **only after** confirming the settings test route no longer references them — that route builds its own framing, so update it to:

```ts
    let answer: string;
    try {
      answer = await callLlm(settings, settings.personalityPrompt, `A Twitch chatter asks: ${question}\nAnswer in one concise chat message.`);
    } catch (llmError) {
      const msg = llmError instanceof Error ? llmError.message : 'LLM request failed.';
      throw new HttpRouteError(502, msg);
    }
    response.json({ ok: true, reply: answer });
```

- [ ] **Step 6: Typecheck**

Run: `bun run typecheck`
Expected: one error in `src/server/actionExecutor.ts` — `askPonderLlm` no longer exists. That is fixed in Task 6; do not patch it here.

- [ ] **Step 7: Commit**

```bash
git add src/server/llmContext.ts src/server/llmChatLines.test.ts src/server/llm.ts
git commit -m "feat: read recent chat lines and run pre-assembled LLM requests"
```

---

### Task 6: Executor wiring

**Files:**
- Modify: `src/server/actionExecutor.ts` (`ActionExecutorDeps`, `chatMessageForLlm` removal, the `llm_response` arm)
- Modify: `src/server/viewerIdentity.ts` (add `getViewerTags`)
- Create: `src/server/llmStep.test.ts`

**Interfaces:**
- Consumes: `tagGateAllows` (Task 1), `withLlmPayloadDefaults` (Task 2), `loadInteractions` / `recordInteraction` (Task 3), `buildLlmRequest` / `parseLlmReply` / `formatLlmReply` / `LlmChatLine` (Task 4), `recentChatLines` / `runLlmRequest` / `getPersonalityPrompt` (Task 5).
- Produces: `getViewerTags(login: string): string[]` from `src/server/viewerIdentity.ts`; new optional deps on `ActionExecutorDeps`: `resolveViewerTags`, `recentChatLines`, `loadInteractions`, `recordInteraction`, `personalityPrompt`, and a changed `askLlm: (instructions: string, input: string) => Promise<string>`.

- [ ] **Step 1: Add the tag lookup**

In `src/server/viewerIdentity.ts`:

```ts
const selectProfileTags = db.prepare('select tags_json as tagsJson from viewer_profiles where login = ?');

/** The operator's own tags for a viewer, used by the llm_response targeting gate. */
export function getViewerTags(login: string): string[] {
  const key = login.trim().toLowerCase();
  if (!key) return [];
  const row = selectProfileTags.get(key) as { tagsJson: string } | undefined;
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.tagsJson) as unknown;
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === 'string') : [];
  } catch {
    return [];
  }
}
```

- [ ] **Step 2: Write the failing test**

Create `src/server/llmStep.test.ts`:

```ts
import { expect, test } from 'bun:test';
import type { Action, LlmResponsePayload, TemplateContext } from '../shared/api';
import { createActionExecutor } from './actionExecutor';
import type { ActionExecutorDeps } from './actionExecutor';

const payload = (overrides: Partial<LlmResponsePayload> = {}): LlmResponsePayload => ({
  template: 'Answer {actor}',
  systemPrompt: '',
  systemPromptMode: 'enhance',
  chatHistoryLines: 0,
  interactionHistory: 0,
  examples: [],
  allowTags: [],
  denyTags: [],
  allowDecline: false,
  mention: true,
  ...overrides,
});

function actionWith(llmPayload: LlmResponsePayload): Action {
  return {
    id: 'action-1',
    name: 'Lurk',
    description: '',
    enabled: true,
    quickDisable: false,
    steps: [{ id: 'step-1', position: 0, enabled: true, delayMs: 0, type: 'llm_response', payload: llmPayload }],
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-20T00:00:00.000Z',
  };
}

type Harness = {
  sent: string[];
  recorded: Array<{ login: string; prompt: string; reply: string }>;
  requests: Array<{ instructions: string; input: string }>;
};

function harness(overrides: Partial<ActionExecutorDeps> = {}) {
  const state: Harness = { sent: [], recorded: [], requests: [] };
  const deps: ActionExecutorDeps = {
    resolveMedia: () => null,
    state: {} as never,
    personalityPrompt: () => 'You are Narya.',
    resolveViewerTags: () => [],
    recentChatLines: () => [],
    loadInteractions: () => [],
    recordInteraction: (login, prompt, reply) => { state.recorded.push({ login, prompt, reply }); },
    askLlm: async (instructions, input) => {
      state.requests.push({ instructions, input });
      return 'the answer';
    },
    sendChat: async (_runtime, message) => { state.sent.push(message); return undefined; },
    ...overrides,
  };
  return { state, executor: createActionExecutor(deps) };
}

async function run(llmPayload: LlmResponsePayload, context: TemplateContext, overrides: Partial<ActionExecutorDeps> = {}) {
  const action = actionWith(llmPayload);
  const { state, executor } = harness({ loadAction: () => action, ...overrides });
  const result = await executor.runAction('action-1', context);
  return { state, result };
}

test('a plain step sends the answer with an @mention', async () => {
  const { state, result } = await run(payload(), { actor: 'Bob', login: 'bob' });
  expect(result.status).toBe('succeeded');
  expect(state.sent).toEqual(['@Bob the answer']);
});

test('mention off sends the answer bare', async () => {
  const { state } = await run(payload({ mention: false }), { actor: 'Bob', login: 'bob' });
  expect(state.sent).toEqual(['the answer']);
});

test('a denied tag skips the step and never calls the model', async () => {
  const { state, result } = await run(
    payload({ denyTags: ['no-llm'] }),
    { actor: 'Bob', login: 'bob' },
    { resolveViewerTags: () => ['no-llm'] },
  );
  expect(result.status).toBe('skipped');
  expect(state.requests).toEqual([]);
  expect(state.sent).toEqual([]);
});

test('the deny gate matches regardless of the case the tag was saved in', async () => {
  const { result } = await run(
    payload({ denyTags: ['no-llm'] }),
    { actor: 'Bob', login: 'bob' },
    { resolveViewerTags: () => ['No-LLM'] },
  );
  expect(result.status).toBe('skipped');
});

test('an allow list admits a viewer holding the tag', async () => {
  const { result } = await run(
    payload({ allowTags: ['vip'] }),
    { actor: 'Bob', login: 'bob' },
    { resolveViewerTags: () => ['vip'] },
  );
  expect(result.status).toBe('succeeded');
});

test('an allow list rejects an invocation with no login', async () => {
  const { result } = await run(payload({ allowTags: ['vip'] }), {});
  expect(result.status).toBe('skipped');
});

test('a decline sends nothing and records nothing', async () => {
  const { state, result } = await run(
    payload({ allowDecline: true }),
    { actor: 'Bob', login: 'bob' },
    { askLlm: async () => '{"respond": false}' },
  );
  expect(result.status).toBe('skipped');
  expect(state.sent).toEqual([]);
  expect(state.recorded).toEqual([]);
});

test('a successful reply is recorded to interaction memory', async () => {
  const { state } = await run(payload(), { actor: 'Bob', login: 'bob' });
  expect(state.recorded).toEqual([{ login: 'bob', prompt: 'Answer Bob', reply: 'the answer' }]);
});

test('a failed chat send records nothing', async () => {
  // A chat outage must not record an exchange the viewer never saw.
  const { state, result } = await run(
    payload(),
    { actor: 'Bob', login: 'bob' },
    { sendChat: async () => { throw new Error('chat is down'); } },
  );
  expect(result.status).toBe('failed');
  expect(state.recorded).toEqual([]);
});

test('an invocation with no login records nothing', async () => {
  const { state } = await run(payload({ allowTags: [] }), { actor: 'System' });
  expect(state.recorded).toEqual([]);
});

test('chat lines are requested only when the step asks for them', async () => {
  let asked = -1;
  await run(payload({ chatHistoryLines: 7 }), { actor: 'Bob', login: 'bob' }, {
    recentChatLines: (limit) => { asked = limit; return []; },
  });
  expect(asked).toBe(7);
});

test('chat lines are not requested when the count is zero', async () => {
  let called = false;
  await run(payload({ chatHistoryLines: 0 }), { actor: 'Bob', login: 'bob' }, {
    recentChatLines: () => { called = true; return []; },
  });
  expect(called).toBe(false);
});

test('an empty prompt template skips before any gate or model call', async () => {
  const { state, result } = await run(payload({ template: '' }), { actor: 'Bob', login: 'bob' });
  expect(result.status).toBe('skipped');
  expect(state.requests).toEqual([]);
});

test('the resolved tags reach the prompt so the model can see them', async () => {
  const { state } = await run(
    payload(),
    { actor: 'Bob', login: 'bob' },
    { resolveViewerTags: () => ['artist'] },
  );
  expect(state.requests[0]!.input).toContain('artist');
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test src/server/llmStep.test.ts`
Expected: FAIL — `personalityPrompt` and the other new deps are not on `ActionExecutorDeps`

- [ ] **Step 4: Extend the deps**

In `src/server/actionExecutor.ts`, replace the `askLlm?:` line in `ActionExecutorDeps` with:

```ts
  /** Runs an assembled request. Prompt construction lives in llmPrompt.ts. */
  askLlm?: (instructions: string, input: string) => Promise<string>;
  /** The global personality prompt an llm_response step enhances or overrides. */
  personalityPrompt?: () => string;
  /** The operator's own tags for a viewer, for the llm_response targeting gate. */
  resolveViewerTags?: (login: string) => string[];
  /** Recent channel chat for an llm_response step's context. */
  recentChatLines?: (limit: number) => LlmChatLine[];
  /** Prior exchanges between this viewer and the bot. */
  loadInteractions?: (login: string, limit: number) => LlmInteractionTurn[];
  /** Records an exchange AFTER it has reached chat. */
  recordInteraction?: (login: string, prompt: string, reply: string) => void;
```

Update the imports at the top of the file: remove `import { askPonderLlm } from './llm';` and add

```ts
import { getPersonalityPrompt, runLlmRequest } from './llm';
import {
  loadInteractions as loadInteractionsImpl,
  recentChatLines as recentChatLinesImpl,
  recordInteraction as recordInteractionImpl,
} from './llmContext';
import type { LlmChatLine, LlmInteractionTurn } from './llmContext';
import { buildLlmRequest, formatLlmReply, parseLlmReply } from './llmPrompt';
import { getViewerTags } from './viewerIdentity';
import { tagGateAllows } from '../shared/viewerTags';
```

**Do not import `./chat` here.** `chat.ts` imports `automation.ts`, which imports this
file; adding the reverse edge closes a load-time cycle and fails at boot rather than as a
clean error. That is why `recentChatLines` lives in `llmContext.ts`.

Delete the now-unused `chatMessageForLlm` helper (lines ~102–120) and drop `ChatMessage` from the type imports if nothing else in the file uses it.

In the destructuring block inside `createActionExecutor`, replace the `askLlm = …` default and add the rest:

```ts
    askLlm = runLlmRequest,
    personalityPrompt = getPersonalityPrompt,
    resolveViewerTags = getViewerTags,
    recentChatLines = recentChatLinesImpl,
    loadInteractions = loadInteractionsImpl,
    recordInteraction = recordInteractionImpl,
```

- [ ] **Step 5: Rewrite the `llm_response` arm**

Replace the `case 'llm_response':` block in `dispatch`:

```ts
      case 'llm_response': {
        const prompt = render(step.payload.template);
        if (!prompt.trim()) return skipped('The LLM prompt rendered empty.');

        const login = context.login ?? '';
        // Resolved before the request so a denied viewer costs no tokens and no latency.
        const tags = login ? resolveViewerTags(login) : [];
        if (!tagGateAllows(tags, step.payload.allowTags, step.payload.denyTags)) {
          // A tagged viewer running the command is normal traffic, not a fault — the
          // same reasoning quote_show applies to a query that matches nothing.
          return skipped('This viewer is excluded from LLM replies by tag.');
        }

        const request = buildLlmRequest({
          personalityPrompt: personalityPrompt(),
          payload: step.payload,
          context: { ...context, tags },
          prompt,
          chatLines: step.payload.chatHistoryLines > 0 ? recentChatLines(step.payload.chatHistoryLines) : [],
          interactions: login && step.payload.interactionHistory > 0
            ? loadInteractions(login, step.payload.interactionHistory)
            : [],
        });

        const reply = parseLlmReply(await askLlm(request.instructions, request.input), step.payload.allowDecline);
        if (!reply.respond) return skipped('The LLM chose not to respond.');
        if (!reply.message.trim()) return skipped('The LLM returned no text.');

        const message = formatLlmReply(reply.message, context.actor ?? context.login ?? '', step.payload.mention);
        await sendChat(state, message, 'bot');
        // AFTER the send, never before: a chat outage must not record an exchange the
        // viewer never saw.
        if (login) recordInteraction(login, prompt, reply.message);
        return SUCCEEDED;
      }
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test src/server/llmStep.test.ts`
Expected: PASS, 14 tests

- [ ] **Step 7: Confirm no second play path appeared**

Run: `bun test src/server/redeemOnce.test.ts`
Expected: PASS. This suite exists to catch a redeem being played twice; the LLM step must not have introduced a second delivery path.

- [ ] **Step 8: Commit**

```bash
git add src/server/actionExecutor.ts src/server/viewerIdentity.ts src/server/llmStep.test.ts
git commit -m "feat: gate, contextualize, and record llm_response steps"
```

---

### Task 7: Role and tags in the template context

Makes `{role}` and `{tags}` available to every template, and is what the actor block renders from.

**Files:**
- Modify: `src/shared/api.ts` (`TemplateContext`, line ~988)
- Modify: `src/server/triggerDispatcher.ts:285-315` (chat context construction)
- Modify: `src/server/actionTemplates.ts` (token rendering, if it enumerates keys)
- Create: `src/server/templateRoleTokens.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `TemplateContext.role?: string` and `TemplateContext.tags?: string[]`.

- [ ] **Step 1: Write the failing test**

Create `src/server/templateRoleTokens.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { renderActionTemplate } from './actionTemplates';

test('{role} renders the actor role', () => {
  expect(renderActionTemplate('hi {role}', { role: 'mod' }, () => null)).toBe('hi mod');
});

test('{tags} renders a comma-separated list', () => {
  expect(renderActionTemplate('{tags}', { tags: ['vip', 'artist'] }, () => null)).toBe('vip, artist');
});

test('{role} and {tags} render empty when absent, like {months} outside a resub', () => {
  expect(renderActionTemplate('[{role}][{tags}]', {}, () => null)).toBe('[][]');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/server/templateRoleTokens.test.ts`
Expected: FAIL — `{role}` renders literally

- [ ] **Step 3: Extend the contract**

In `src/shared/api.ts`, add to `TemplateContext` before the quote tokens:

```ts
  /**
   * The actor's highest Twitch role and the operator's own profile tags at invocation
   * time. Set by the chat dispatcher; absent elsewhere, so they render empty the same
   * way {months} does outside a resub.
   */
  role?: string;
  tags?: string[];
```

- [ ] **Step 4: Render the tokens**

In `src/server/actionTemplates.ts`, add `role` and `tags` to the token table. `tags` is an array, so it needs an explicit join — find where `args` is handled and mirror it:

```ts
    case 'role': return context.role ?? '';
    case 'tags': return (context.tags ?? []).join(', ');
```

(Match the file's existing switch or lookup-map shape; if it maps over `Object.entries(context)`, add a formatter for the array case rather than a new branch.)

- [ ] **Step 5: Populate from the dispatcher**

In `src/server/triggerDispatcher.ts`, at the top of the chat handler where `actor` and `word` are derived (line ~285), add:

```ts
    const role = getRoleFromBadges(message.badges);
    const tags = login ? getViewerTags(login) : [];
```

Add to the imports:

```ts
import { getRoleFromBadges } from '../shared/roles';
import { getViewerTags } from './viewerIdentity';
```

Then add `role, tags,` to **both** `context:` object literals in that handler — the `chat_phrase` one (line ~299) and the `viewer_command` one (line ~310).

- [ ] **Step 6: Run the tests**

Run: `bun test src/server/templateRoleTokens.test.ts src/server/triggerDispatcher.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/shared/api.ts src/server/actionTemplates.ts src/server/triggerDispatcher.ts src/server/templateRoleTokens.test.ts
git commit -m "feat: expose actor role and viewer tags to Action templates"
```

---

### Task 8: Client-side validation and step defaults

Mirrors the server's limits so a mistake is an inline message rather than a 400 round-trip. The server stays the authority.

**Files:**
- Modify: `src/client/pages/settings/automation.ts` (`newStep`, `describeStep`, `stepError`)
- Create: `src/client/pages/settings/llmStepValidation.test.ts`

**Interfaces:**
- Consumes: the caps exported from `src/shared/api.ts` (Task 2).
- Produces: nothing new; existing `newStep` / `describeStep` / `stepError` behaviour extended.

- [ ] **Step 1: Write the failing test**

Create `src/client/pages/settings/llmStepValidation.test.ts`:

```ts
import { expect, test } from 'bun:test';
import type { ActionStepInput } from '../../../shared/api';
import { newStep, stepError } from './automation';

function llmStep(overrides: Record<string, unknown> = {}): ActionStepInput {
  const base = newStep('llm_response');
  return { ...base, payload: { ...(base.payload as object), template: 'Answer {actor}', ...overrides } } as ActionStepInput;
}

test('a new LLM step carries every field with mention on', () => {
  const step = newStep('llm_response') as Extract<ActionStepInput, { type: 'llm_response' }>;
  expect(step.payload.mention).toBe(true);
  expect(step.payload.systemPromptMode).toBe('enhance');
  expect(step.payload.chatHistoryLines).toBe(0);
  expect(step.payload.interactionHistory).toBe(0);
  expect(step.payload.allowDecline).toBe(false);
});

test('a missing prompt is still an error', () => {
  expect(stepError(llmStep({ template: '' }), 1)).toMatch(/needs a prompt/);
});

test('an over-long system prompt is rejected', () => {
  expect(stepError(llmStep({ systemPrompt: 'x'.repeat(2001) }), 1)).toMatch(/2000/);
});

test('too many chat lines is rejected', () => {
  expect(stepError(llmStep({ chatHistoryLines: 51 }), 1)).toMatch(/50/);
});

test('a negative chat line count is rejected', () => {
  expect(stepError(llmStep({ chatHistoryLines: -1 }), 1)).toMatch(/between 0 and 50/);
});

test('too many replayed interactions is rejected', () => {
  expect(stepError(llmStep({ interactionHistory: 21 }), 1)).toMatch(/20/);
});

test('too many examples is rejected', () => {
  expect(stepError(llmStep({
    examples: Array.from({ length: 11 }, () => ({ input: 'a', output: 'b' })),
  }), 1)).toMatch(/10/);
});

test('an example with an empty side is rejected', () => {
  expect(stepError(llmStep({ examples: [{ input: 'a', output: '' }] }), 1)).toMatch(/both an input and an output/);
});

test('a valid step has no error', () => {
  expect(stepError(llmStep({ chatHistoryLines: 10, interactionHistory: 3 }), 1)).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/client/pages/settings/llmStepValidation.test.ts`
Expected: FAIL — `newStep('llm_response')` returns `{ template: '' }` only

- [ ] **Step 3: Extend `newStep`**

In `src/client/pages/settings/automation.ts`, replace the `case 'llm_response':` arm of `newStep`:

```ts
    case 'llm_response':
      return {
        type,
        enabled: true,
        delayMs: 0,
        payload: {
          template: '',
          systemPrompt: '',
          systemPromptMode: 'enhance',
          chatHistoryLines: 0,
          interactionHistory: 0,
          examples: [],
          allowTags: [],
          denyTags: [],
          allowDecline: false,
          // Matches the stored default: every existing step mentions today.
          mention: true,
        },
      };
```

- [ ] **Step 4: Extend `stepError`**

Replace the `case 'llm_response':` arm of `stepError`:

```ts
    case 'llm_response': {
      if (templateMissing(step.payload.template)) return `${where}: needs a prompt.`;
      if (step.payload.systemPrompt.length > MAX_LLM_SYSTEM_PROMPT_LENGTH) {
        return `${where}: the system prompt must be ${MAX_LLM_SYSTEM_PROMPT_LENGTH} characters or fewer.`;
      }
      if (step.payload.chatHistoryLines < 0 || step.payload.chatHistoryLines > MAX_LLM_CHAT_HISTORY_LINES) {
        return `${where}: chat history must be between 0 and ${MAX_LLM_CHAT_HISTORY_LINES} lines.`;
      }
      if (step.payload.interactionHistory < 0 || step.payload.interactionHistory > MAX_LLM_INTERACTION_HISTORY) {
        return `${where}: interaction history must be between 0 and ${MAX_LLM_INTERACTION_HISTORY}.`;
      }
      if (step.payload.examples.length > MAX_LLM_EXAMPLES) {
        return `${where}: at most ${MAX_LLM_EXAMPLES} examples.`;
      }
      if (step.payload.examples.some(pair => !pair.input.trim() || !pair.output.trim())) {
        return `${where}: every example needs both an input and an output.`;
      }
      if (step.payload.examples.some(pair =>
        pair.input.length > MAX_LLM_EXAMPLE_LENGTH || pair.output.length > MAX_LLM_EXAMPLE_LENGTH)) {
        return `${where}: example text must be ${MAX_LLM_EXAMPLE_LENGTH} characters or fewer.`;
      }
      return null;
    }
```

Add the caps to the existing `import type { … }` → make it a value import from `'../../../shared/api'`:

```ts
import {
  MAX_LLM_CHAT_HISTORY_LINES,
  MAX_LLM_EXAMPLE_LENGTH,
  MAX_LLM_EXAMPLES,
  MAX_LLM_INTERACTION_HISTORY,
  MAX_LLM_SYSTEM_PROMPT_LENGTH,
} from '../../../shared/api';
```

- [ ] **Step 5: Extend `describeStep`**

The `llm_response` case currently shares an arm with `tts_speak`. Split it so the summary shows the levers in use:

```ts
    case 'tts_speak':
      return step.payload.template || '(empty)';
    case 'llm_response': {
      const parts = [step.payload.template || '(empty)'];
      if (step.payload.systemPromptMode === 'override') parts.push('override persona');
      if (step.payload.chatHistoryLines > 0) parts.push(`${step.payload.chatHistoryLines} chat lines`);
      if (step.payload.interactionHistory > 0) parts.push(`${step.payload.interactionHistory} prior turns`);
      if (step.payload.denyTags.length > 0) parts.push(`deny: ${step.payload.denyTags.join(', ')}`);
      if (step.payload.allowTags.length > 0) parts.push(`allow: ${step.payload.allowTags.join(', ')}`);
      if (step.payload.allowDecline) parts.push('may decline');
      return parts.join(' · ');
    }
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test src/client/pages/settings/llmStepValidation.test.ts`
Expected: PASS, 9 tests

- [ ] **Step 7: Commit**

```bash
git add src/client/pages/settings/automation.ts src/client/pages/settings/llmStepValidation.test.ts
git commit -m "feat: validate LLM step context and targeting in the editor"
```

---

### Task 9: The editor UI

`StepPayloadFields` already spans `ActionsPage.tsx:120-568`. The LLM editor is the largest single arm yet, so it goes in its own file rather than growing that function further.

Design-system findings that constrain this task (from `docs/superpowers/specs/2026-07-20-llm-action-context-design.md`):
- The Narya DS exports **no form controls** and no disclosure component. Follow the local step-editor idiom: `.field`, `.settings-wide-field`, `.action-hint`.
- Grouping is a **separator rule**, not a collapsible — hiding a deny-list behind a click would conceal the setting that makes a command silently stop replying.
- Booleans are `<select>`, not checkboxes: the step editor has no checkbox precedent.
- Reuse `.tag-chip-list` / `.tag-chip` (`panel.css:2323`) verbatim.

**Files:**
- Create: `src/client/pages/settings/LlmStepFields.tsx`
- Modify: `src/client/pages/settings/ActionsPage.tsx:243-255` (replace the shared `tts_speak` / `llm_response` arm)
- Modify: `src/client/styles/panel.css` (add `.action-step-group`)

**Interfaces:**
- Consumes: `addProfileTag` / `normalizeProfileTag` (Task 1), the caps (Task 2), `newStep` defaults (Task 8).
- Produces: `LlmStepFields({ step, disabled, onChange })` from `src/client/pages/settings/LlmStepFields.tsx`.

- [ ] **Step 1: Add the group separator style**

In `src/client/styles/panel.css`, next to the other action-editor styles (near `.action-hint`):

```css
/* Groups the LLM step's context and targeting fields. A separator, not a collapsible:
   the deny-list is what makes a command silently stop replying, so it must stay
   visible. Matches the TweakSection idiom — small, uppercase, letter-spaced. */
.action-step-group {
  grid-column: 1 / -1;
  margin-top: 6px;
  padding-top: 8px;
  border-top: 1px solid var(--border-1);
  color: var(--fg-3);
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: var(--track-caps);
  text-transform: uppercase;
}
.action-step-group:first-child { margin-top: 0; padding-top: 0; border-top: none; }
```

- [ ] **Step 2: Write the component**

Create `src/client/pages/settings/LlmStepFields.tsx`:

```tsx
import React from 'react';
import type { ActionStepInput, LlmExample, LlmSystemPromptMode } from '../../../shared/api';
import {
  MAX_LLM_CHAT_HISTORY_LINES,
  MAX_LLM_EXAMPLE_LENGTH,
  MAX_LLM_EXAMPLES,
  MAX_LLM_INTERACTION_HISTORY,
  MAX_LLM_SYSTEM_PROMPT_LENGTH,
} from '../../../shared/api';
import { addProfileTag } from '../../../shared/viewerTags';
import { Icon } from '../../ui/icons';

type LlmStep = Extract<ActionStepInput, { type: 'llm_response' }>;

/** The chip editor from the Viewer Profile modal, reused so a tag typed here looks and
 *  normalizes exactly like one typed there. */
function TagGate({
  label,
  sub,
  tags,
  disabled,
  onChange,
}: {
  label: string;
  sub: string;
  tags: string[];
  disabled: boolean;
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = React.useState('');

  const commit = (value: string) => {
    const next = addProfileTag(tags, value);
    if (next !== tags) onChange(next);
    setDraft('');
  };

  return (
    <label className="field settings-wide-field">
      <span>{label}</span>
      <div className="tag-chip-list">
        {tags.map(tag => (
          <span className="tag-chip" key={tag}>
            {tag}
            <button
              type="button"
              aria-label={`Remove ${tag}`}
              disabled={disabled}
              onClick={() => onChange(tags.filter(item => item !== tag))}
            >
              <Icon name="x" />
            </button>
          </span>
        ))}
      </div>
      <input
        value={draft}
        disabled={disabled}
        placeholder="Type a tag and press Enter"
        onChange={event => setDraft(event.target.value)}
        onBlur={() => { if (draft.trim()) commit(draft); }}
        onKeyDown={event => {
          if (event.key !== 'Enter') return;
          // The step editor sits inside a form; Enter must add a tag, not save.
          event.preventDefault();
          if (draft.trim()) commit(draft);
        }}
      />
      <small className="action-hint">{sub}</small>
    </label>
  );
}

export function LlmStepFields({
  step,
  disabled,
  onChange,
}: {
  step: LlmStep;
  disabled: boolean;
  onChange: (next: ActionStepInput) => void;
}): React.ReactElement {
  const patch = (fields: Partial<LlmStep['payload']>) =>
    onChange({ ...step, payload: { ...step.payload, ...fields } });

  const setExample = (index: number, fields: Partial<LlmExample>) => {
    patch({ examples: step.payload.examples.map((pair, i) => (i === index ? { ...pair, ...fields } : pair)) });
  };

  return (
    <>
      <label className="field settings-wide-field">
        <span>Prompt</span>
        <input
          value={step.payload.template}
          disabled={disabled}
          maxLength={500}
          placeholder="Answer {actor} in one sentence: {input}"
          onChange={event => patch({ template: event.target.value })}
        />
        <small className="action-hint">
          Tokens: {'{actor} {login} {input} {role} {tags} {arg1} {rest}'}
        </small>
      </label>

      <div className="action-step-group">Persona</div>

      <label className="field settings-wide-field">
        <span>System prompt</span>
        <textarea
          value={step.payload.systemPrompt}
          disabled={disabled}
          rows={3}
          maxLength={MAX_LLM_SYSTEM_PROMPT_LENGTH}
          placeholder="If they are a moderator, answer briefly and defer to them."
          onChange={event => patch({ systemPrompt: event.target.value })}
        />
        <small className="action-hint">
          Leave empty to use the personality prompt from Settings → LLM on its own.
        </small>
      </label>

      <label className="field">
        <span>Combine with personality</span>
        <select
          value={step.payload.systemPromptMode}
          disabled={disabled}
          onChange={event => patch({ systemPromptMode: event.target.value as LlmSystemPromptMode })}
        >
          <option value="enhance">Enhance — add to the personality prompt</option>
          <option value="override">Override — replace it entirely</option>
        </select>
      </label>

      <div className="action-step-group">Context</div>

      <label className="field">
        <span>Recent chat lines</span>
        <input
          type="number"
          min={0}
          max={MAX_LLM_CHAT_HISTORY_LINES}
          value={step.payload.chatHistoryLines}
          disabled={disabled}
          onChange={event => patch({ chatHistoryLines: Math.trunc(Number(event.target.value)) || 0 })}
        />
        <small className="action-hint">0 sends none. Moderated messages are never included.</small>
      </label>

      <label className="field">
        <span>Prior exchanges</span>
        <input
          type="number"
          min={0}
          max={MAX_LLM_INTERACTION_HISTORY}
          value={step.payload.interactionHistory}
          disabled={disabled}
          onChange={event => patch({ interactionHistory: Math.trunc(Number(event.target.value)) || 0 })}
        />
        <small className="action-hint">
          Replays this viewer&apos;s last exchanges with the bot. 0 sends none.
        </small>
      </label>

      <div className="action-step-group">Examples</div>

      {step.payload.examples.map((pair, index) => (
        <div className="field settings-wide-field" key={index}>
          <span>Example {index + 1}</span>
          <input
            value={pair.input}
            disabled={disabled}
            maxLength={MAX_LLM_EXAMPLE_LENGTH}
            placeholder="What a viewer says"
            onChange={event => setExample(index, { input: event.target.value })}
          />
          <input
            value={pair.output}
            disabled={disabled}
            maxLength={MAX_LLM_EXAMPLE_LENGTH}
            placeholder="How the bot should answer"
            onChange={event => setExample(index, { output: event.target.value })}
          />
          <button
            type="button"
            className="icon-btn"
            aria-label={`Remove example ${index + 1}`}
            disabled={disabled}
            onClick={() => patch({ examples: step.payload.examples.filter((_, i) => i !== index) })}
          >
            <Icon name="x" />
          </button>
        </div>
      ))}
      {step.payload.examples.length < MAX_LLM_EXAMPLES && (
        <button
          type="button"
          className="btn-ghost"
          disabled={disabled}
          onClick={() => patch({ examples: [...step.payload.examples, { input: '', output: '' }] })}
        >
          Add example
        </button>
      )}

      <div className="action-step-group">Targeting</div>

      <TagGate
        label="Only these tags"
        sub="Leave empty to allow everyone. A run with no viewer is excluded when this is set."
        tags={step.payload.allowTags}
        disabled={disabled}
        onChange={allowTags => patch({ allowTags })}
      />
      <TagGate
        label="Never these tags"
        sub="Wins over the allow list. The step is skipped and the model is never called."
        tags={step.payload.denyTags}
        disabled={disabled}
        onChange={denyTags => patch({ denyTags })}
      />

      <div className="action-step-group">Reply</div>

      <label className="field">
        <span>May decline</span>
        <select
          value={step.payload.allowDecline ? 'yes' : 'no'}
          disabled={disabled}
          onChange={event => patch({ allowDecline: event.target.value === 'yes' })}
        >
          <option value="no">Always reply</option>
          <option value="yes">Let the model stay silent</option>
        </select>
        <small className="action-hint">Asks for a JSON reply so it can choose not to answer.</small>
      </label>

      <label className="field">
        <span>Mention the viewer</span>
        <select
          value={step.payload.mention ? 'yes' : 'no'}
          disabled={disabled}
          onChange={event => patch({ mention: event.target.value === 'yes' })}
        >
          <option value="yes">Prefix with @name</option>
          <option value="no">Send without a mention</option>
        </select>
      </label>
    </>
  );
}
```

- [ ] **Step 3: Wire it into the step editor**

In `src/client/pages/settings/ActionsPage.tsx`, the arm at line ~243 currently reads `case 'tts_speak': case 'llm_response':`. Split it:

```tsx
    case 'tts_speak':
      return (
        <label className="field settings-wide-field">
          <span>Say</span>
          <input
            value={step.payload.template}
            disabled={disabled}
            maxLength={500}
            placeholder="{actor} says {input}"
            onChange={event => onChange({ ...step, payload: { ...step.payload, template: event.target.value } })}
          />
          <small className="action-hint">{TEMPLATE_HINT}</small>
        </label>
      );

    case 'llm_response':
      return <LlmStepFields step={step} disabled={disabled} onChange={onChange} />;
```

Add the import at the top of the file:

```ts
import { LlmStepFields } from './LlmStepFields';
```

- [ ] **Step 4: Typecheck and build**

Run: `bun run typecheck && bun run build`
Expected: both succeed. If `btn-ghost` or `icon-btn` is not a real class, check `panel.css` and use the class the neighbouring Actions buttons use.

- [ ] **Step 5: Commit**

```bash
git add src/client/pages/settings/LlmStepFields.tsx src/client/pages/settings/ActionsPage.tsx src/client/styles/panel.css
git commit -m "feat: add the LLM step context and targeting editor"
```

---

### Task 10: Full verification

**Files:** none modified unless a check fails.

- [ ] **Step 1: Run the whole suite**

Run: `bun test`
Expected: PASS, except the ~21 pre-existing media-asset failures if running in a git worktree (gitignored `public/clips`, `public/sounds`). Confirm each failure names a media asset before dismissing it — anything else is a real regression.

- [ ] **Step 2: Typecheck and build**

Run: `bun run typecheck && bun run build`
Expected: both succeed.

- [ ] **Step 3: Start a dev server against a scratch database**

`bun run dev` uses the operator's **live** Twitch and OBS credentials even with a scratch DB, so do not exercise anything that writes to Twitch.

```bash
lsof -i :4317 -i :5173
STREAMER_TOOLS_DB=/tmp/claude-1000/-home-codeacula-Storage-Projects-narya/b6c99043-64b9-46a8-aa7e-c74f4bc6cb18/scratchpad/llm-check.sqlite bun run dev
```

Confirm the port is free first and stop any stale project process.

- [ ] **Step 4: Smoke-test the backend**

```bash
curl http://localhost:4317/api/health
curl http://localhost:4317/api/chat/recent
```

Expected: both return JSON without a 500.

- [ ] **Step 5: Validate the editor in Chrome**

Open the Actions settings page, add an `llm_response` step, and confirm by inspection:

1. All four group separators render as uppercase rules — Persona, Context, Examples, Targeting, Reply.
2. The system prompt is a multi-line textarea; the two counts are number inputs that refuse values above their caps.
3. Adding a tag to **Never these tags** renders a pill chip with a working remove button, and pressing Enter adds the tag **without submitting the form**.
4. Both booleans are dropdowns, not checkboxes.
5. Saving persists; reloading the page brings every field back.
6. Nothing overflows its container at a narrow window width.

Capture a screenshot of the expanded step editor for the PR.

- [ ] **Step 6: Verify back-compat against a pre-existing step**

In the scratch database, an Action created before this change stores `{ template }` only. Confirm such a step loads with **Mention the viewer: Prefix with @name** selected. If a legacy step is not present, insert one directly:

```bash
bun test src/server/llmStepPayload.test.ts
```

The "mention defaults to true" test covers this; the UI check confirms it survives the round trip to the editor.

- [ ] **Step 7: Stop the dev server and commit any fixes**

```bash
git add -A
git commit -m "fix: address issues found in LLM step verification"
```

Skip the commit if nothing needed fixing.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| 1 Payload + read-boundary defaults | 2 |
| 2 Tag gate | 1 (predicate), 6 (enforcement) |
| 3 Prompt assembly | 4 |
| 4 Declining | 4 (parser), 6 (step behaviour) |
| 5 Interaction memory | 3 (store + flush), 6 (record-after-send) |
| 6 Chat history | 5 |
| 7 Limits | 2 (server), 8 (client) |
| 8 Shared tag normalization | 1 |
| 9 Template context role/tags | 7 |
| UI | 9 |
| Testing + verification | every task, plus 10 |

**Known deviations from the spec, deliberate:**
- The spec named `resolveViewerTags` and a chat-line port without saying where the real implementations live. `getViewerTags` goes in `viewerIdentity.ts` (the identity module). `recentChatLines` does **not** go in `chat.ts` despite `chat.ts` owning the table: `chat.ts → automation.ts → actionExecutor.ts` already exists, so an executor import of `chat.ts` would close a load-time cycle and crash at boot — the trap `windDown.ts` documents. Both it and interaction memory live in `llmContext.ts`, which imports only `db.ts`. Reading `chat_messages` from a second module is already the norm (`routes.ts:85`, `dashboard/status.ts:132`).
- Both context types (`LlmChatLine`, `LlmInteractionTurn`) are declared in `llmContext.ts` rather than `llmPrompt.ts`, so the dependency runs strictly one way.
- The spec's `formatLlmReply` was described as moving "with" `formatPonderReply`. This plan places it in `llmPrompt.ts` alongside the other pure text functions and deletes `formatPonderReply` outright, since `llm.ts` keeps no caller.
