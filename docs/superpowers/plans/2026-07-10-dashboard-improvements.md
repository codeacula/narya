# Dashboard Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the tablet soundboard's stuck highlight; add stream-category management with per-category tags that auto-apply and a real tag autocomplete; add a Viewers page with VIP/Moderator management. Leave "Twitch-managed" rewards as-is (Twitch platform limit).

**Architecture:** Backend is modular Express (one module per responsibility, registered in `src/server/index.ts`). Tag storage/suggestions go in a new leaf module `src/server/tags.ts` (depends only on `db`) to avoid an import cycle with `twitch/api.ts`. Category↔tag and reverse reward-group data extend `src/server/streamCategories.ts`. VIP/mod endpoints go in a new `src/server/viewers.ts`. Frontend is a pathname router with page components rendered inside `Dashboard.tsx`; new pages are added to `routing.ts`, the `NavBar`, and the render switch. All client data flows through `src/client/services/dashboard.ts` and shared contracts in `src/shared/api.ts`.

**Tech Stack:** Bun, TypeScript (strict), React, Express, `better-sqlite`-style prepared statements via `src/server/db.ts`, `bun:test`.

## Global Constraints

- TypeScript strict mode; two-space indentation; no linter/formatter.
- React components PascalCase; hooks `useCamelCase`; overlay/tablet CSS classes camelCase (`src/client/styles.css`), dashboard/panel CSS classes kebab-case (`src/client/styles/panel.css`).
- Client/server payload types live in `src/shared/api.ts` — import them, never duplicate.
- Semantic commits: `feat:`/`fix:`/`refactor:`/`docs:` + short imperative subject. End commit messages with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Twitch tags: alphanumeric (Unicode letters/numbers), no leading `#`, ≤25 chars each, ≤10 tags.
- Server tests are `*.test.ts` colocated with source, run under `NODE_ENV=test` (in-memory DB). Client changes have no unit-test harness in this repo — their gate is `bun run typecheck` + `bun run build` + in-browser check.
- Verification after every task: `bun run typecheck`, `bun test`, `bun run build`. Confirm port 4317/5173 free (`lsof -i :4317`) before starting a dev server.
- Work happens on branch `redesign-tablet-and-statbar`; all tasks land there sequentially.

---

## Task 1: Tablet soundboard/clip buttons — clear the stuck gold highlight (Feature A)

**Files:**
- Modify: `src/client/pages/Tablet.tsx` (sound/clip button `onClick` handlers, ~lines 204-219)

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing other tasks depend on.

**Why:** `.tabletShell button:focus-visible` (`src/client/styles.css:79`) draws a gold outline. On touch, sound/clip buttons keep focus after the tap so the outline sticks. These are fire-and-forget buttons — blur them on activation. Scene/transition buttons reflect state and keep their focus behavior.

- [ ] **Step 1: Blur the sound buttons on tap**

In `src/client/pages/Tablet.tsx`, change the sound button (currently):

```tsx
              {soundButtons.length > 0 ? soundButtons.map(sound => (
                <button key={sound.id} onClick={() => playSound(sound.id)}>
                  {sound.label}
                </button>
              )) : <p className="muted">No sounds yet — add them in Settings → Content.</p>}
```

to:

```tsx
              {soundButtons.length > 0 ? soundButtons.map(sound => (
                <button
                  key={sound.id}
                  onClick={event => { event.currentTarget.blur(); playSound(sound.id); }}
                >
                  {sound.label}
                </button>
              )) : <p className="muted">No sounds yet — add them in Settings → Content.</p>}
```

- [ ] **Step 2: Blur the clip buttons on tap**

In the same file, change the clip button (currently):

```tsx
              {clipButtons.length > 0 ? clipButtons.map(clip => (
                <button key={clip.id} onClick={() => playClip(clip.id)}>
                  {clip.label}
                </button>
              )) : <p className="muted">No clips yet — add them in Settings → Content.</p>}
```

to:

```tsx
              {clipButtons.length > 0 ? clipButtons.map(clip => (
                <button
                  key={clip.id}
                  onClick={event => { event.currentTarget.blur(); playClip(clip.id); }}
                >
                  {clip.label}
                </button>
              )) : <p className="muted">No clips yet — add them in Settings → Content.</p>}
```

- [ ] **Step 3: Typecheck and build**

Run: `bun run typecheck && bun run build`
Expected: both pass, no errors.

- [ ] **Step 4: Verify in browser**

Run `bun run dev` (confirm `lsof -i :4317` is empty first). Open `http://localhost:5173/tablet`, tap a Sounds button and a Clips button. Expected: the gold outline does NOT persist after the tap; the button plays. Tab to a button with the keyboard — the gold focus outline still appears (accessibility preserved).

- [ ] **Step 5: Commit**

```bash
git add src/client/pages/Tablet.tsx
git commit -m "fix: clear tablet soundboard highlight after tap

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Tag store & suggestions module (Feature B/C backend core)

**Files:**
- Modify: `src/server/db.ts` (add two tables inside the `create table if not exists` block, ~after line 195)
- Create: `src/server/tags.ts`
- Create: `src/server/tags.test.ts`

**Interfaces:**
- Consumes: `db` from `./db`.
- Produces (relied on by Tasks 3, 4):
  - `normalizeTag(value: string): string`
  - `normalizeTags(value: unknown): string[]`
  - `recordTagHistory(tags: string[]): void`
  - `suggestTagHistory(query: string, limit?: number): string[]`
  - `mergeTagSuggestions(params: { history: string[]; channelTags: string[]; candidate: string; limit?: number }): string[]`

- [ ] **Step 1: Add the two tables to the schema**

In `src/server/db.ts`, inside the big `db.exec(\`` … `\`)` schema block, right after the `stream_categories` table definition (ends at `);` around line 195), add:

```sql
  create table if not exists stream_category_tags (
    game_id text not null,
    tag text not null,
    created_at text not null,
    primary key (game_id, tag)
  );

  create table if not exists stream_tag_history (
    tag_key text primary key,
    display text not null,
    last_used_at text not null
  );
```

- [ ] **Step 2: Write the failing test**

Create `src/server/tags.test.ts`:

```ts
import { beforeEach, describe, expect, test } from 'bun:test';
import { db } from './db';
import {
  mergeTagSuggestions,
  normalizeTag,
  normalizeTags,
  recordTagHistory,
  suggestTagHistory,
} from './tags';

describe('normalizeTag', () => {
  test('strips a leading # and non-alphanumerics, caps at 25 chars', () => {
    expect(normalizeTag('#Speedrun!')).toBe('Speedrun');
    expect(normalizeTag('  hello world  ')).toBe('helloworld');
    expect(normalizeTag('x'.repeat(40))).toHaveLength(25);
  });
});

describe('normalizeTags', () => {
  test('dedupes case-insensitively and caps at 10', () => {
    expect(normalizeTags(['Chill', 'chill', 'Cozy'])).toEqual(['Chill', 'Cozy']);
    expect(normalizeTags(Array.from({ length: 15 }, (_, i) => `t${i}`))).toHaveLength(10);
  });
  test('ignores non-arrays and non-strings', () => {
    expect(normalizeTags('nope')).toEqual([]);
    expect(normalizeTags([1, {}, 'ok'])).toEqual(['ok']);
  });
});

describe('tag history', () => {
  beforeEach(() => { db.exec('delete from stream_tag_history'); });

  test('records tags and suggests them by substring, most-recent first', () => {
    recordTagHistory(['Cozy']);
    recordTagHistory(['Speedrun', 'Coding']);
    // Later inserts are more recent; "co" matches Coding and Cozy.
    expect(suggestTagHistory('co')).toEqual(['Coding', 'Cozy']);
  });

  test('an empty query returns recent history', () => {
    recordTagHistory(['Alpha']);
    recordTagHistory(['Beta']);
    expect(suggestTagHistory('')).toEqual(['Beta', 'Alpha']);
  });

  test('re-recording a tag refreshes its recency without duplicating', () => {
    recordTagHistory(['Alpha']);
    recordTagHistory(['Beta']);
    recordTagHistory(['Alpha']);
    expect(suggestTagHistory('')).toEqual(['Alpha', 'Beta']);
  });
});

describe('mergeTagSuggestions', () => {
  test('history first, then channel tags, then the typed candidate, deduped, capped', () => {
    const merged = mergeTagSuggestions({
      history: ['Coding', 'Cozy'],
      channelTags: ['Cozy', 'English'],
      candidate: 'Coding',
      limit: 8,
    });
    expect(merged).toEqual(['Coding', 'Cozy', 'English']);
  });
  test('adds the candidate when it is not already present', () => {
    expect(mergeTagSuggestions({ history: [], channelTags: [], candidate: 'Fresh' }))
      .toEqual(['Fresh']);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun test src/server/tags.test.ts`
Expected: FAIL — `Cannot find module './tags'` (or export errors).

- [ ] **Step 4: Implement `src/server/tags.ts`**

```ts
import { db } from './db';

// Twitch tags are free-form: Unicode letters/numbers only, no leading '#', ≤25 chars.
export function normalizeTag(value: string): string {
  return value.trim().replace(/^#/, '').replace(/[^\p{L}\p{N}]/gu, '').slice(0, 25);
}

export function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const tag = normalizeTag(item);
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    tags.push(tag);
    if (tags.length === 10) break;
  }
  return tags;
}

const upsertTagHistory = db.prepare(`
  insert into stream_tag_history (tag_key, display, last_used_at)
  values (?, ?, ?)
  on conflict(tag_key) do update set
    display = excluded.display,
    last_used_at = excluded.last_used_at
`);

// Remember every tag the streamer actually uses — Twitch no longer exposes a tag
// search API, so this local history is the only real source of autocomplete.
export function recordTagHistory(tags: string[]): void {
  const now = new Date().toISOString();
  for (const raw of tags) {
    const tag = normalizeTag(raw);
    if (!tag) continue;
    upsertTagHistory.run(tag.toLowerCase(), tag, now);
  }
}

const suggestAllTags = db.prepare(`
  select display from stream_tag_history
  order by last_used_at desc
  limit ?
`);
const suggestMatchingTags = db.prepare(`
  select display from stream_tag_history
  where tag_key like ?
  order by last_used_at desc
  limit ?
`);

// normalizeTag strips '%' and '_', so the candidate can be spliced into a LIKE
// pattern without escaping — no wildcard can survive normalization.
export function suggestTagHistory(query: string, limit = 8): string[] {
  const candidate = normalizeTag(query).toLowerCase();
  const rows = candidate
    ? suggestMatchingTags.all(`%${candidate}%`, limit)
    : suggestAllTags.all(limit);
  return (rows as Array<{ display: string }>).map(row => row.display);
}

// Merge the tag type-ahead sources for the Stream Info box: history first, then
// the channel's current tags, then the typed candidate last so a brand-new tag is
// always addable. Deduped case-insensitively, capped at `limit`.
export function mergeTagSuggestions(params: {
  history: string[];
  channelTags: string[];
  candidate: string;
  limit?: number;
}): string[] {
  const { history, channelTags, candidate, limit = 8 } = params;
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (value: string) => {
    const tag = normalizeTag(value);
    if (!tag) return;
    const key = tag.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(tag);
  };
  for (const tag of history) add(tag);
  for (const tag of channelTags) add(tag);
  if (candidate) add(candidate);
  return out.slice(0, limit);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test src/server/tags.test.ts`
Expected: PASS (all cases).

- [ ] **Step 6: Full verification**

Run: `bun run typecheck && bun test && bun run build`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/server/db.ts src/server/tags.ts src/server/tags.test.ts
git commit -m "feat: add local tag history store and suggestion merge

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Category tags & reward-group associations + endpoints (Feature B backend)

**Files:**
- Modify: `src/shared/api.ts` (extend `SavedStreamCategory`, add `StreamCategoryRewardGroup`, ~lines 277-290)
- Modify: `src/server/streamCategories.ts` (add stores, extend list payload, add endpoints)
- Modify: `src/server/streamCategories.test.ts` — CREATE this file (none exists yet)

**Interfaces:**
- Consumes: `normalizeTags`, `recordTagHistory`, `suggestTagHistory` from `./tags` (Task 2).
- Produces (relied on by Tasks 5, 6):
  - Shared: `StreamCategoryRewardGroup = { id: string; name: string }`; `SavedStreamCategory = TwitchCategorySuggestion & { hidden: boolean; tags: string[]; rewardGroups: StreamCategoryRewardGroup[] }`
  - Routes: `PUT /api/stream-categories/:gameId/tags` → `SavedStreamCategory[]`; `DELETE /api/stream-categories/:gameId` → `SavedStreamCategory[]`; `GET /api/stream-tags?query=` → `string[]`
  - `GET /api/stream-categories` now returns each row with `tags` and `rewardGroups`.

- [ ] **Step 1: Extend the shared contract**

In `src/shared/api.ts`, replace:

```ts
export type SavedStreamCategory = TwitchCategorySuggestion & { hidden: boolean };
```

with:

```ts
export type StreamCategoryRewardGroup = { id: string; name: string };

export type SavedStreamCategory = TwitchCategorySuggestion & {
  hidden: boolean;
  tags: string[];
  rewardGroups: StreamCategoryRewardGroup[];
};
```

- [ ] **Step 2: Write the failing test**

Create `src/server/streamCategories.test.ts`:

```ts
import { beforeEach, describe, expect, test } from 'bun:test';
import { db } from './db';
import {
  deleteSavedStreamCategory,
  listSavedStreamCategories,
  setSavedStreamCategoryTags,
} from './streamCategories';

function seedCategory(id: string, name: string) {
  db.prepare('insert or replace into stream_categories (game_id, game_name, box_art_url, hidden, created_at) values (?, ?, null, 0, ?)')
    .run(id, name, new Date().toISOString());
}

describe('saved stream category tags', () => {
  beforeEach(() => {
    db.exec('delete from stream_category_tags');
    db.exec('delete from stream_categories');
    db.exec('delete from stream_tag_history');
  });

  test('setting tags replaces the prior set and records history', () => {
    seedCategory('111', 'Test Game');
    setSavedStreamCategoryTags('111', ['Cozy', 'Chill']);
    setSavedStreamCategoryTags('111', ['Speedrun']);
    const cat = listSavedStreamCategories().find(c => c.id === '111');
    expect(cat?.tags).toEqual(['Speedrun']);
  });

  test('tags are normalized and deduped', () => {
    seedCategory('222', 'Another');
    setSavedStreamCategoryTags('222', ['#Cozy', 'cozy', 'Chill!']);
    const cat = listSavedStreamCategories().find(c => c.id === '222');
    expect(cat?.tags).toEqual(['Cozy', 'Chill']);
  });

  test('deleting a saved category removes it and its tags', () => {
    seedCategory('333', 'Gone');
    setSavedStreamCategoryTags('333', ['Tag']);
    deleteSavedStreamCategory('333');
    expect(listSavedStreamCategories().some(c => c.id === '333')).toBe(false);
    expect(db.prepare('select count(*) as n from stream_category_tags where game_id = ?').get('333'))
      .toEqual({ n: 0 });
  });

  test('rewardGroups reflect viewer_reward_category_games mappings', () => {
    seedCategory('444', 'Mapped Game');
    db.prepare('insert or replace into viewer_reward_categories (id, name, enabled, created_at, updated_at) values (?, ?, 1, ?, ?)')
      .run('grp1', 'Combat Rewards', new Date().toISOString(), new Date().toISOString());
    db.prepare('insert or replace into viewer_reward_category_games (category_id, game_id, game_name, created_at) values (?, ?, ?, ?)')
      .run('grp1', '444', 'Mapped Game', new Date().toISOString());
    const cat = listSavedStreamCategories().find(c => c.id === '444');
    expect(cat?.rewardGroups).toEqual([{ id: 'grp1', name: 'Combat Rewards' }]);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun test src/server/streamCategories.test.ts`
Expected: FAIL — `listSavedStreamCategories`/`setSavedStreamCategoryTags`/`deleteSavedStreamCategory` not exported.

- [ ] **Step 4: Implement the stores and extend the payload in `src/server/streamCategories.ts`**

Add imports at the top (after the existing imports):

```ts
import type { SavedStreamCategory, SavedStreamCategoryInput, StreamCategoryRewardGroup } from '../shared/api';
import { normalizeTags, recordTagHistory, suggestTagHistory } from './tags';
```

(Adjust the existing `import type { SavedStreamCategory, SavedStreamCategoryInput }` line so the two new type names are included and not imported twice — keep a single `import type { … }` from `../shared/api`.)

Add these prepared statements next to the existing ones:

```ts
const listCategoryTagsRow = db.prepare(`select game_id as gameId, tag from stream_category_tags`);
const deleteCategoryTagsRow = db.prepare(`delete from stream_category_tags where game_id = ?`);
const insertCategoryTagRow = db.prepare(`insert or ignore into stream_category_tags (game_id, tag, created_at) values (?, ?, ?)`);
const deleteStreamCategoryRow = db.prepare(`delete from stream_categories where game_id = ?`);
const listRewardGroupsByGameRow = db.prepare(`
  select g.game_id as gameId, c.id as id, c.name as name
  from viewer_reward_category_games g
  join viewer_reward_categories c on c.id = g.category_id
  order by c.name collate nocase
`);

const replaceCategoryTagsTxn = db.transaction((gameId: string, tags: string[]) => {
  deleteCategoryTagsRow.run(gameId);
  const now = new Date().toISOString();
  for (const tag of tags) insertCategoryTagRow.run(gameId, tag, now);
});

const deleteStreamCategoryTxn = db.transaction((gameId: string) => {
  deleteCategoryTagsRow.run(gameId);
  return deleteStreamCategoryRow.run(gameId).changes;
});
```

Add the map builders and exported functions:

```ts
function tagsByGame(): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const row of listCategoryTagsRow.all() as Array<{ gameId: string; tag: string }>) {
    const list = map.get(row.gameId) ?? [];
    list.push(row.tag);
    map.set(row.gameId, list);
  }
  return map;
}

function rewardGroupsByGame(): Map<string, StreamCategoryRewardGroup[]> {
  const map = new Map<string, StreamCategoryRewardGroup[]>();
  for (const row of listRewardGroupsByGameRow.all() as Array<{ gameId: string; id: string; name: string }>) {
    const list = map.get(row.gameId) ?? [];
    list.push({ id: row.id, name: row.name });
    map.set(row.gameId, list);
  }
  return map;
}

export function listSavedStreamCategories(): SavedStreamCategory[] {
  const tags = tagsByGame();
  const groups = rewardGroupsByGame();
  return (listStreamCategoriesRow.all() as StreamCategoryRow[]).map(row => ({
    id: row.id,
    name: row.name,
    boxArtUrl: row.boxArtUrl ?? null,
    hidden: row.hidden === 1,
    tags: tags.get(row.id) ?? [],
    rewardGroups: groups.get(row.id) ?? [],
  }));
}

export function setSavedStreamCategoryTags(gameId: string, rawTags: unknown): string[] {
  const tags = normalizeTags(rawTags);
  replaceCategoryTagsTxn(gameId, tags);
  recordTagHistory(tags);
  return tags;
}

export function deleteSavedStreamCategory(gameId: string): boolean {
  return deleteStreamCategoryTxn(gameId) > 0;
}
```

Now DELETE the old private `listStreamCategories` function (the one at the top that returns `SavedStreamCategory[]` without tags) and replace every internal call to `listStreamCategories()` in this file's routes with `listSavedStreamCategories()`. (There are three: in `GET`, `POST`, and `PATCH /api/stream-categories`.)

- [ ] **Step 5: Add the new routes**

Inside `registerStreamCategoryRoutes`, after the existing `PATCH /api/stream-categories/:gameId` route, add:

```ts
  app.put('/api/stream-categories/:gameId/tags', (request, response) => {
    try {
      const id = normalizeGameId(request.params.gameId);
      if (!listStreamCategoriesRow.all().some((row) => (row as StreamCategoryRow).id === id)) {
        throw new HttpRouteError(404, 'Saved stream category not found.');
      }
      setSavedStreamCategoryTags(id, (request.body as { tags?: unknown })?.tags);
      response.json(listSavedStreamCategories());
    } catch (error) {
      sendRouteError(response, error);
    }
  });

  app.delete('/api/stream-categories/:gameId', (request, response) => {
    try {
      const id = normalizeGameId(request.params.gameId);
      if (!deleteSavedStreamCategory(id)) throw new HttpRouteError(404, 'Saved stream category not found.');
      response.json(listSavedStreamCategories());
    } catch (error) {
      sendRouteError(response, error);
    }
  });

  app.get('/api/stream-tags', (request, response) => {
    const query = typeof request.query['query'] === 'string' ? request.query['query'] : '';
    response.json(suggestTagHistory(query));
  });
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test src/server/streamCategories.test.ts`
Expected: PASS.

- [ ] **Step 7: Full verification**

Run: `bun run typecheck && bun test && bun run build`
Expected: all pass. (Typecheck will flag any missed `listStreamCategories()` call sites — fix them to `listSavedStreamCategories()`.)

- [ ] **Step 8: Commit**

```bash
git add src/shared/api.ts src/server/streamCategories.ts src/server/streamCategories.test.ts
git commit -m "feat: store per-category tags and reward-group associations

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Record tag history on save + rewrite tag suggestions (Feature C backend)

**Files:**
- Modify: `src/server/twitch/api.ts` (remove local tag normalizers, import from `./tags`, record history on stream-info save, rewrite `GET /api/twitch/tag-suggestions`)

**Interfaces:**
- Consumes: `normalizeTag`, `normalizeTags`, `recordTagHistory`, `suggestTagHistory`, `mergeTagSuggestions` from `../tags`.
- Produces: `GET /api/twitch/tag-suggestions` now returns history-backed suggestions (still `string[]`), resilient when Twitch is unavailable.

- [ ] **Step 1: Replace the local tag normalizers with the shared module**

In `src/server/twitch/api.ts`, DELETE these two functions (currently ~lines 513-530):

```ts
export function normalizeTags(value: unknown): string[] { /* … */ }
export function normalizeTwitchTagCandidate(value: string): string { /* … */ }
```

Add to the imports at the top of the file:

```ts
import { mergeTagSuggestions, normalizeTag, normalizeTags, recordTagHistory, suggestTagHistory } from '../tags';
```

Then replace the one remaining internal use of `normalizeTwitchTagCandidate(` with `normalizeTag(` (it appears in the old tag-suggestions route, which Step 3 rewrites anyway). Search the file for `normalizeTwitchTagCandidate` and confirm zero remain.

- [ ] **Step 2: Record tag history when the streamer saves stream info**

In `PATCH /api/twitch/stream-info`, immediately after the successful Twitch update (right before `await applyRewardGroupsForStreamCategory(state, gameId);`), add:

```ts
      // Remember these tags so the type-ahead can suggest them next time.
      recordTagHistory(tags);
```

- [ ] **Step 3: Rewrite the tag-suggestions route**

Replace the entire `app.get('/api/twitch/tag-suggestions', …)` handler with:

```ts
  app.get('/api/twitch/tag-suggestions', async (request, response) => {
    try {
      const query = typeof request.query['query'] === 'string' ? request.query['query'].trim() : '';
      const candidate = normalizeTag(query);
      const history = suggestTagHistory(query, 8);

      // The channel's current tags are a nice-to-have; if Twitch is unreachable or
      // unauthenticated, fall back to history-only suggestions rather than 500ing.
      let channelTags: string[] = [];
      try {
        const credentials = await getTwitchActionCredentials(state, []);
        const res = await fetch(
          `https://api.twitch.tv/helix/channels?broadcaster_id=${encodeURIComponent(credentials.broadcasterId)}`,
          { headers: { 'Client-Id': credentials.clientId, Authorization: credentials.authorization } },
        );
        if (res.ok) {
          const data = await res.json() as { data?: Array<{ tags?: string[] }> };
          channelTags = normalizeTags(data.data?.[0]?.tags ?? []);
        }
      } catch {
        // history-only suggestions
      }

      response.json(mergeTagSuggestions({ history, channelTags, candidate }));
    } catch (error) {
      sendRouteError(response, error);
    }
  });
```

- [ ] **Step 4: Full verification**

Run: `bun run typecheck && bun test && bun run build`
Expected: all pass. Typecheck confirms no dangling references to the removed exports.

- [ ] **Step 5: Verify in browser**

With `bun run dev` running and Twitch connected, open the dashboard → Stream Info modal. Type in the Tags box: it should now suggest previously-used tags (save a couple tags first to seed history), not only the exact string you typed.

- [ ] **Step 6: Commit**

```bash
git add src/server/twitch/api.ts
git commit -m "feat: back tag suggestions with local history

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Stream Categories management page (Feature B frontend)

**Files:**
- Modify: `src/client/services/dashboard.ts` (add service methods)
- Modify: `src/client/routing.ts` (add `categories` route)
- Modify: `src/client/ui/shell.tsx` (nav link)
- Modify: `src/client/pages/Dashboard.tsx` (route normalization + render branch)
- Create: `src/client/pages/StreamCategoriesPage.tsx`

**Interfaces:**
- Consumes: `getSavedStreamCategories` (now returns `tags`+`rewardGroups`), and new `setStreamCategoryTags`, `deleteStreamCategory`, `getTagHistorySuggestions`.
- Produces: a `categories` dashboard route rendering `StreamCategoriesPage`.

- [ ] **Step 1: Add service methods**

In `src/client/services/dashboard.ts`, after `setSavedStreamCategoryHidden` (~line 154), add:

```ts
export async function setStreamCategoryTags(gameId: string, tags: string[]): Promise<SavedStreamCategory[]> {
  return sendJson<SavedStreamCategory[]>(`/api/stream-categories/${encodeURIComponent(gameId)}/tags`, 'PUT', { tags });
}

export async function deleteStreamCategory(gameId: string): Promise<SavedStreamCategory[]> {
  return sendJson<SavedStreamCategory[]>(`/api/stream-categories/${encodeURIComponent(gameId)}`, 'DELETE');
}

export async function getTagHistorySuggestions(query: string): Promise<string[]> {
  return fetchJson<string[]>(`/api/stream-tags?query=${encodeURIComponent(query)}`);
}
```

- [ ] **Step 2: Add the route**

Replace the contents of `src/client/routing.ts` with:

```ts
export type DashboardRoute = 'dashboard' | 'settings' | 'rewards' | 'categories' | 'viewers';

function normalizePath(pathname: string): string {
  return pathname.replace(/\/+$/, '') || '/';
}

export function dashboardRouteFromPath(pathname: string): DashboardRoute {
  const path = normalizePath(pathname);
  if (path === '/settings/rewards') return 'rewards';
  if (path === '/settings/categories') return 'categories';
  if (path === '/viewers') return 'viewers';
  if (path === '/settings') return 'settings';
  return 'dashboard';
}

export function pathForDashboardRoute(route: DashboardRoute): string {
  if (route === 'settings') return '/settings';
  if (route === 'rewards') return '/settings/rewards';
  if (route === 'categories') return '/settings/categories';
  if (route === 'viewers') return '/viewers';
  return '/dashboard';
}
```

(The `viewers` route is used by Task 8; adding it now keeps `routing.ts` edited once.)

- [ ] **Step 3: Widen the route guard in Dashboard.tsx**

In `src/client/pages/Dashboard.tsx`, replace line 145:

```tsx
    const route: DashboardRoute = nextPage === 'settings' || nextPage === 'rewards' ? nextPage : 'dashboard';
```

with:

```tsx
    const knownRoutes = ['settings', 'rewards', 'categories', 'viewers'] as const;
    const route: DashboardRoute = (knownRoutes as readonly string[]).includes(nextPage) ? nextPage as DashboardRoute : 'dashboard';
```

- [ ] **Step 4: Add the nav links**

In `src/client/ui/shell.tsx`, inside `NavBar`'s `<div className="navlinks">`, after the "viewer rewards" button (~line 79), add:

```tsx
        <button
          className={'navlink' + (page === 'categories' ? ' active' : '')}
          onClick={() => setPage('categories')}
        >
          categories
        </button>
        <button
          className={'navlink' + (page === 'viewers' ? ' active' : '')}
          onClick={() => setPage('viewers')}
        >
          viewers
        </button>
```

(The "viewers" link is wired to its page in Task 8; until then it renders a placeholder — added now to touch `shell.tsx` once.)

- [ ] **Step 5: Create the page**

Create `src/client/pages/StreamCategoriesPage.tsx`:

```tsx
import React from 'react';
import type { SavedStreamCategory } from '../../shared/api';
import {
  deleteStreamCategory,
  getSavedStreamCategories,
  getTagHistorySuggestions,
  setSavedStreamCategoryHidden,
  setStreamCategoryTags,
} from '../services/dashboard';
import { formatBoxArtUrl, useDebouncedSuggestions } from '../suggestions';
import { SUGGESTION_DISMISS_MS } from '../../shared/constants';
import { Icon } from '../ui/icons';

function normalizeTagInput(value: string): string {
  return value.trim().replace(/^#/, '').replace(/[^\p{L}\p{N}]/gu, '').slice(0, 25);
}

function CategoryCard({
  category,
  busy,
  onSaveTags,
  onToggleHidden,
  onDelete,
}: {
  category: SavedStreamCategory;
  busy: boolean;
  onSaveTags: (tags: string[]) => void;
  onToggleHidden: () => void;
  onDelete: () => void;
}) {
  const [tags, setTags] = React.useState<string[]>(category.tags);
  const [tagInput, setTagInput] = React.useState('');
  const [tagFocused, setTagFocused] = React.useState(false);
  const dirty = tags.join(' ') !== category.tags.join(' ');

  // Keep local edits in sync when the server list refreshes after a save.
  React.useEffect(() => { setTags(category.tags); }, [category.tags]);

  const tagFetcher = React.useCallback(
    (query: string) => getTagHistorySuggestions(query).then(list => {
      const selected = new Set(tags.map(t => t.toLowerCase()));
      return list.filter(t => !selected.has(t.toLowerCase()));
    }),
    [tags],
  );
  const { suggestions, loading } = useDebouncedSuggestions(tagInput, tagFetcher, { minLength: 1 });
  const showSuggestions = tagFocused && (loading || suggestions.length > 0);

  const addTag = (value: string) => {
    const tag = normalizeTagInput(value);
    if (!tag) return;
    setTags(current => (current.length >= 10 || current.some(t => t.toLowerCase() === tag.toLowerCase()) ? current : [...current, tag]));
    setTagInput('');
  };
  const removeTag = (tag: string) => setTags(current => current.filter(t => t !== tag));

  const art = formatBoxArtUrl(category.boxArtUrl, 36, 48);
  return (
    <div className={'set-group category-card' + (category.hidden ? ' is-hidden' : '')}>
      <div className="category-card-head">
        {art ? <img className="suggestion-art" src={art} alt="" /> : <span className="suggestion-art placeholder" />}
        <div className="category-card-title">
          <b>{category.name}</b>
          {category.hidden ? <span className="reward-state">Hidden</span> : null}
        </div>
        <div className="category-card-actions">
          <button className="modbtn" type="button" disabled={busy} onClick={onToggleHidden}>
            {category.hidden ? 'Unhide' : 'Hide'}
          </button>
          <button className="modbtn danger" type="button" disabled={busy} onClick={onDelete}>Remove</button>
        </div>
      </div>

      <div className="field">
        <span>Tags applied when you switch to this category</span>
        <div className="tag-chip-list">
          {tags.map(tag => (
            <span className="tag-chip" key={tag}>
              {tag}
              <button type="button" title={`Remove ${tag}`} onClick={() => removeTag(tag)}>
                <Icon name="x" size={11} />
              </button>
            </span>
          ))}
        </div>
        <div className="suggestion-anchor">
          <input
            aria-label={`Add tag to ${category.name}`}
            value={tagInput}
            disabled={busy || tags.length >= 10}
            onFocus={() => setTagFocused(true)}
            onBlur={() => window.setTimeout(() => setTagFocused(false), SUGGESTION_DISMISS_MS)}
            onChange={event => setTagInput(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addTag(tagInput); } }}
          />
          {showSuggestions && (
            <div className="suggestion-list">
              {loading ? (
                <div className="suggestion-empty">Searching tags...</div>
              ) : suggestions.map(tag => (
                <button
                  key={tag}
                  type="button"
                  className="suggestion-item"
                  onMouseDown={event => event.preventDefault()}
                  onClick={() => addTag(tag)}
                >
                  <span>{tag}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="category-card-tagsave">
          <small>{tags.length}/10</small>
          <button className="modbtn gold" type="button" disabled={busy || !dirty} onClick={() => onSaveTags(tags)}>
            {dirty ? 'Save tags' : 'Saved'}
          </button>
        </div>
      </div>

      {category.rewardGroups.length > 0 && (
        <div className="field">
          <span>Reward groups that switch with this category</span>
          <div className="tag-chip-list">
            {category.rewardGroups.map(group => (
              <span className="tag-chip" key={group.id}>{group.name}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function StreamCategoriesPage({ onBack }: { onBack: () => void }) {
  const [categories, setCategories] = React.useState<SavedStreamCategory[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [showHidden, setShowHidden] = React.useState(false);

  React.useEffect(() => {
    getSavedStreamCategories()
      .then(setCategories)
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : 'Could not load stream categories.'))
      .finally(() => setLoading(false));
  }, []);

  const run = async (action: () => Promise<SavedStreamCategory[]>) => {
    setBusy(true);
    setError(null);
    try {
      setCategories(await action());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Action failed.');
    } finally {
      setBusy(false);
    }
  };

  const visible = categories.filter(cat => showHidden || !cat.hidden);
  const hiddenCount = categories.filter(cat => cat.hidden).length;

  return (
    <div className="settings-page">
      <div className="settings-inner">
        <div className="rewards-header">
          <div>
            <div className="settings-eyebrow">settings</div>
            <h2 className="settings-title">Stream categories</h2>
            <p className="set-intro">Manage the Twitch categories you stream. Tags you assign here replace your stream tags automatically when you switch to that category in Stream Info.</p>
          </div>
          <button className="modbtn" type="button" onClick={onBack}>Back to settings</button>
        </div>

        {error ? <div className="set-status error">{error}</div> : null}

        {loading ? (
          <div className="reward-loading">Loading stream categories...</div>
        ) : categories.length === 0 ? (
          <div className="reward-empty-state">
            <h3>No saved categories yet</h3>
            <p>Categories are saved automatically when you pick one in Stream Info or map one to a reward group.</p>
          </div>
        ) : (
          <>
            {hiddenCount > 0 && (
              <label className="reward-toggle">
                <input type="checkbox" checked={showHidden} onChange={() => setShowHidden(v => !v)} />
                <span>Show hidden ({hiddenCount})</span>
              </label>
            )}
            {visible.map(category => (
              <CategoryCard
                key={category.id}
                category={category}
                busy={busy}
                onSaveTags={tags => void run(() => setStreamCategoryTags(category.id, tags))}
                onToggleHidden={() => void run(() => setSavedStreamCategoryHidden(category.id, !category.hidden))}
                onDelete={() => {
                  if (window.confirm(`Remove "${category.name}" from saved categories? Its tag mappings are deleted.`)) {
                    void run(() => deleteStreamCategory(category.id));
                  }
                }}
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Render the page in Dashboard.tsx**

In `src/client/pages/Dashboard.tsx`, add the import near the other page imports (~line 30):

```tsx
import { StreamCategoriesPage } from './StreamCategoriesPage';
```

Replace the render block (lines 698-706):

```tsx
      {page === 'dashboard' ? dashboardLayout : page === 'rewards' ? (
        <ViewerRewardsPage onBack={() => changePage('settings')} />
      ) : (
        <SettingsPage
          status={status}
          onTwitchLogout={handleTwitchLogout}
          onTwitchBotLogout={handleTwitchBotLogout}
        />
      )}
```

with:

```tsx
      {page === 'dashboard' ? dashboardLayout : page === 'rewards' ? (
        <ViewerRewardsPage onBack={() => changePage('settings')} />
      ) : page === 'categories' ? (
        <StreamCategoriesPage onBack={() => changePage('settings')} />
      ) : (
        <SettingsPage
          status={status}
          onTwitchLogout={handleTwitchLogout}
          onTwitchBotLogout={handleTwitchBotLogout}
        />
      )}
```

(The `viewers` branch is added in Task 8; until then a `viewers` page falls through to Settings, which is harmless.)

- [ ] **Step 7: Add minimal styling**

In `src/client/styles/panel.css`, append:

```css
.category-card-head {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}
.category-card-title {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  font-size: 15px;
}
.category-card-actions { display: flex; gap: 8px; }
.category-card-tagsave {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 8px;
}
.category-card.is-hidden { opacity: 0.6; }
```

- [ ] **Step 8: Full verification + browser check**

Run: `bun run typecheck && bun test && bun run build`
Expected: all pass.
Then with `bun run dev`: open `http://localhost:5173/settings/categories` (or click "categories" in the nav). Expected: saved categories list; add/remove tags and Save; Hide/Unhide; Remove (with confirm). Tag input autocompletes from history.

- [ ] **Step 9: Commit**

```bash
git add src/client/services/dashboard.ts src/client/routing.ts src/client/ui/shell.tsx src/client/pages/Dashboard.tsx src/client/pages/StreamCategoriesPage.tsx src/client/styles/panel.css
git commit -m "feat: add stream categories management page

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Auto-apply category tags in the Stream Info modal (Feature B frontend)

**Files:**
- Modify: `src/client/pages/StreamInfoModal.tsx` (replace tags when a category with a saved tag set is picked; fix inline `SavedStreamCategory` literals for the new fields)

**Interfaces:**
- Consumes: `SavedStreamCategory.tags` (Task 3).
- Produces: nothing downstream.

- [ ] **Step 1: Fix the two inline `SavedStreamCategory` literals**

`SavedStreamCategory` now requires `tags` and `rewardGroups`. In `src/client/pages/StreamInfoModal.tsx`, update the two places that build one inline:

Line ~49 (inside the `seenCategoriesRef` effect):

```tsx
      seenCategoriesRef.current.set(form.categoryId, { id: form.categoryId, name: form.category, boxArtUrl: null, hidden: false, tags: [], rewardGroups: [] });
```

Line ~97 (the `remembered.set(...)` call):

```tsx
    remembered.set(form.categoryId, { id: form.categoryId, name: form.category, boxArtUrl: null, hidden: false, tags: [], rewardGroups: [] });
```

- [ ] **Step 2: Replace tags when a saved category with tags is selected**

In the category `<select>`'s `onChange` (~lines 199-202), replace:

```tsx
                onChange={event => {
                  const picked = categoryOptions.find(option => option.id === event.target.value);
                  if (picked) setForm(current => ({ ...current, category: picked.name, categoryId: picked.id }));
                }}
```

with:

```tsx
                onChange={event => {
                  const picked = categoryOptions.find(option => option.id === event.target.value);
                  if (!picked) return;
                  // The saved list carries each category's tag set; a remembered stub may not.
                  const savedTags = savedCategories.find(cat => cat.id === picked.id)?.tags ?? [];
                  setForm(current => ({
                    ...current,
                    category: picked.name,
                    categoryId: picked.id,
                    // Replace tags only when this category actually defines a set,
                    // so picking an untagged category never wipes the current tags.
                    tags: savedTags.length > 0 ? savedTags : current.tags,
                  }));
                }}
```

- [ ] **Step 3: Full verification + browser check**

Run: `bun run typecheck && bun test && bun run build`
Expected: all pass.
Then with `bun run dev`: on the Categories page assign tags to a category. Open Stream Info, select that category from the dropdown → the Tags field repopulates with that category's set. Select a category with no saved tags → your current tags are left unchanged. Save writes those tags to Twitch as usual.

- [ ] **Step 4: Commit**

```bash
git add src/client/pages/StreamInfoModal.tsx
git commit -m "feat: apply a category's saved tags on selection

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: VIP & Moderator endpoints + scopes (Feature D backend)

**Files:**
- Modify: `src/server/twitch/auth.ts` (add two OAuth scopes)
- Modify: `src/server/twitch/api.ts` (export `resolveTwitchUserId`)
- Create: `src/server/viewers.ts`
- Modify: `src/server/index.ts` (import + register the new routes)

**Interfaces:**
- Consumes: `getTwitchActionCredentials`, `resolveTwitchUserId` from `./twitch/api`; `Chatter` from `../shared/api`.
- Produces (relied on by Task 8):
  - `GET /api/twitch/vips` → `Chatter[]`
  - `GET /api/twitch/moderators` → `Chatter[]`
  - `POST`/`DELETE /api/twitch/users/:login/vip` → `{ ok: true, message: string }`
  - `POST`/`DELETE /api/twitch/users/:login/moderator` → `{ ok: true, message: string }`

- [ ] **Step 1: Add the OAuth scopes**

In `src/server/twitch/auth.ts`, add two entries to `REQUIRED_TWITCH_OAUTH_SCOPES` (after `'moderator:manage:shoutouts',`):

```ts
  'channel:manage:vips',
  'channel:manage:moderators',
```

- [ ] **Step 2: Export `resolveTwitchUserId`**

In `src/server/twitch/api.ts`, change:

```ts
async function resolveTwitchUserId(login: string, credentials: { clientId: string; authorization: string }): Promise<string> {
```

to:

```ts
export async function resolveTwitchUserId(login: string, credentials: { clientId: string; authorization: string }): Promise<string> {
```

- [ ] **Step 3: Create the viewers module**

Create `src/server/viewers.ts`:

```ts
import type express from 'express';
import type { Chatter } from '../shared/api';
import { HttpRouteError, readResponseError, sendRouteError } from './http';
import type { RuntimeState } from './runtime';
import { getTwitchActionCredentials, resolveTwitchUserId } from './twitch/api';

const HELIX = 'https://api.twitch.tv/helix';
const VIP_SCOPE = 'channel:manage:vips';
const MOD_SCOPE = 'channel:manage:moderators';

type ActionCredentials = Awaited<ReturnType<typeof getTwitchActionCredentials>>;

function getHeaders(credentials: ActionCredentials) {
  return { 'Client-Id': credentials.clientId, Authorization: credentials.authorization };
}

async function listRoleUsers(url: string, credentials: ActionCredentials): Promise<Chatter[]> {
  const res = await fetch(url, { headers: getHeaders(credentials) });
  if (!res.ok) {
    const message = await readResponseError(res, 'Twitch request failed.');
    throw new HttpRouteError(res.status === 401 || res.status === 403 ? res.status : 502, message);
  }
  const data = await res.json() as { data?: Array<{ user_id: string; user_login: string; user_name: string }> };
  return (data.data ?? []).map(user => ({ userId: user.user_id, userLogin: user.user_login, userName: user.user_name }));
}

async function writeRole(
  state: RuntimeState,
  scope: string,
  path: string,
  method: 'POST' | 'DELETE',
  login: string,
): Promise<void> {
  const credentials = await getTwitchActionCredentials(state, [scope]);
  const targetId = await resolveTwitchUserId(login, { clientId: credentials.clientId, authorization: credentials.authorization });
  const params = new URLSearchParams({ broadcaster_id: credentials.broadcasterId, user_id: targetId });
  const res = await fetch(`${HELIX}${path}?${params.toString()}`, { method, headers: getHeaders(credentials) });
  if (!res.ok) {
    const message = await readResponseError(res, 'Twitch request failed.');
    const status = [400, 401, 403, 409, 422].includes(res.status) ? res.status : 502;
    throw new HttpRouteError(status, message);
  }
}

export function registerViewerRoleRoutes(app: express.Express, state: RuntimeState) {
  app.get('/api/twitch/vips', async (_request, response) => {
    try {
      const credentials = await getTwitchActionCredentials(state, [VIP_SCOPE]);
      const params = new URLSearchParams({ broadcaster_id: credentials.broadcasterId, first: '100' });
      response.json(await listRoleUsers(`${HELIX}/channels/vips?${params.toString()}`, credentials));
    } catch (error) {
      sendRouteError(response, error);
    }
  });

  app.get('/api/twitch/moderators', async (_request, response) => {
    try {
      const credentials = await getTwitchActionCredentials(state, [MOD_SCOPE]);
      const params = new URLSearchParams({ broadcaster_id: credentials.broadcasterId, first: '100' });
      response.json(await listRoleUsers(`${HELIX}/moderation/moderators?${params.toString()}`, credentials));
    } catch (error) {
      sendRouteError(response, error);
    }
  });

  app.post('/api/twitch/users/:login/vip', async (request, response) => {
    try {
      await writeRole(state, VIP_SCOPE, '/channels/vips', 'POST', request.params.login);
      response.json({ ok: true, message: `@${request.params.login} is now a VIP.` });
    } catch (error) {
      sendRouteError(response, error);
    }
  });

  app.delete('/api/twitch/users/:login/vip', async (request, response) => {
    try {
      await writeRole(state, VIP_SCOPE, '/channels/vips', 'DELETE', request.params.login);
      response.json({ ok: true, message: `@${request.params.login} is no longer a VIP.` });
    } catch (error) {
      sendRouteError(response, error);
    }
  });

  app.post('/api/twitch/users/:login/moderator', async (request, response) => {
    try {
      await writeRole(state, MOD_SCOPE, '/moderation/moderators', 'POST', request.params.login);
      response.json({ ok: true, message: `@${request.params.login} is now a moderator.` });
    } catch (error) {
      sendRouteError(response, error);
    }
  });

  app.delete('/api/twitch/users/:login/moderator', async (request, response) => {
    try {
      await writeRole(state, MOD_SCOPE, '/moderation/moderators', 'DELETE', request.params.login);
      response.json({ ok: true, message: `@${request.params.login} is no longer a moderator.` });
    } catch (error) {
      sendRouteError(response, error);
    }
  });
}
```

- [ ] **Step 4: Register the module**

In `src/server/index.ts`, add the import alongside the other route imports:

```ts
import { registerViewerRoleRoutes } from './viewers';
```

and register it near `registerChattersRoutes(app, runtimeState);`:

```ts
registerViewerRoleRoutes(app, runtimeState);
```

- [ ] **Step 5: Full verification**

Run: `bun run typecheck && bun test && bun run build`
Expected: all pass.

- [ ] **Step 6: Smoke-test the endpoints**

With `bun run dev` running and Twitch connected, reconnect Twitch once (the dashboard will show the new scopes as missing until you do). Then:

```sh
curl http://localhost:4317/api/twitch/vips
curl http://localhost:4317/api/twitch/moderators
```

Expected: JSON arrays (possibly empty). A 403 with a "Reconnect Twitch to grant: channel:manage:vips, channel:manage:moderators" message means the reconnect hasn't happened yet — that's the expected pre-reconnect behavior.

- [ ] **Step 7: Commit**

```bash
git add src/server/twitch/auth.ts src/server/twitch/api.ts src/server/viewers.ts src/server/index.ts
git commit -m "feat: add VIP and moderator management endpoints

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: Viewers page (Feature D frontend)

**Files:**
- Modify: `src/client/services/dashboard.ts` (add role service methods + `Chatter` import)
- Modify: `src/client/pages/Dashboard.tsx` (render branch for `viewers`)
- Create: `src/client/pages/ViewersPage.tsx`
- Modify: `src/client/styles/panel.css` (minimal styling)

**Interfaces:**
- Consumes: `getChatters`, and new `getVips`, `getModerators`, `grantVip`, `removeVip`, `grantModerator`, `removeModerator`, plus existing `sendViewerShoutout`, `timeoutViewer`, `banViewer`.
- Produces: the `viewers` route renders `ViewersPage`. (Route/nav already added in Task 5.)

- [ ] **Step 1: Add role service methods**

In `src/client/services/dashboard.ts`, add `Chatter` to the type import from `../../shared/api` (the import block already pulls `ChattersResponse`; add `Chatter` next to it). Then, after `getChatters` (~line 380), add:

```ts
export async function getVips(): Promise<Chatter[]> {
  return fetchJson<Chatter[]>('/api/twitch/vips');
}

export async function getModerators(): Promise<Chatter[]> {
  return fetchJson<Chatter[]>('/api/twitch/moderators');
}

export async function grantVip(login: string): Promise<TwitchUserActionResult> {
  return sendJson<TwitchUserActionResult>(`/api/twitch/users/${encodeURIComponent(login)}/vip`, 'POST');
}

export async function removeVip(login: string): Promise<TwitchUserActionResult> {
  return sendJson<TwitchUserActionResult>(`/api/twitch/users/${encodeURIComponent(login)}/vip`, 'DELETE');
}

export async function grantModerator(login: string): Promise<TwitchUserActionResult> {
  return sendJson<TwitchUserActionResult>(`/api/twitch/users/${encodeURIComponent(login)}/moderator`, 'POST');
}

export async function removeModerator(login: string): Promise<TwitchUserActionResult> {
  return sendJson<TwitchUserActionResult>(`/api/twitch/users/${encodeURIComponent(login)}/moderator`, 'DELETE');
}
```

- [ ] **Step 2: Create the Viewers page**

Create `src/client/pages/ViewersPage.tsx`:

```tsx
import React from 'react';
import type { Chatter } from '../../shared/api';
import {
  banViewer,
  getChatters,
  getModerators,
  getVips,
  grantModerator,
  grantVip,
  removeModerator,
  removeVip,
  sendViewerShoutout,
  timeoutViewer,
} from '../services/dashboard';

type Role = 'vip' | 'mod' | null;

function roleFor(login: string, vips: Set<string>, mods: Set<string>): Role {
  if (mods.has(login)) return 'mod';
  if (vips.has(login)) return 'vip';
  return null;
}

function ViewerRow({
  login,
  name,
  role,
  busy,
  onAction,
}: {
  login: string;
  name: string;
  role: Role;
  busy: boolean;
  onAction: (action: () => Promise<{ message: string }>, label: string) => void;
}) {
  return (
    <div className="viewer-row">
      <div className="viewer-row-main">
        <b>{name || login}</b>
        {role === 'mod' ? <span className="reward-state on">Mod</span> : null}
        {role === 'vip' ? <span className="reward-state auto">VIP</span> : null}
      </div>
      <div className="viewer-row-actions">
        {role === 'vip'
          ? <button className="modbtn" type="button" disabled={busy} onClick={() => onAction(() => removeVip(login), `remove VIP from @${login}`)}>Un-VIP</button>
          : <button className="modbtn" type="button" disabled={busy} onClick={() => onAction(() => grantVip(login), `VIP @${login}`)}>VIP</button>}
        {role === 'mod'
          ? <button className="modbtn" type="button" disabled={busy} onClick={() => onAction(() => removeModerator(login), `remove mod from @${login}`)}>Un-Mod</button>
          : <button className="modbtn" type="button" disabled={busy} onClick={() => onAction(() => grantModerator(login), `mod @${login}`)}>Mod</button>}
        <button className="modbtn" type="button" disabled={busy} onClick={() => onAction(() => sendViewerShoutout(login), `shout out @${login}`)}>Shoutout</button>
        <button className="modbtn" type="button" disabled={busy} onClick={() => onAction(() => timeoutViewer(login, 600, ''), `time out @${login}`)}>Timeout</button>
        <button
          className="modbtn danger"
          type="button"
          disabled={busy}
          onClick={() => { if (window.confirm(`Ban @${login}?`)) onAction(() => banViewer(login, ''), `ban @${login}`); }}
        >
          Ban
        </button>
      </div>
    </div>
  );
}

export function ViewersPage() {
  const [chatters, setChatters] = React.useState<Chatter[]>([]);
  const [vips, setVips] = React.useState<Chatter[]>([]);
  const [mods, setMods] = React.useState<Chatter[]>([]);
  const [search, setSearch] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    setError(null);
    const results = await Promise.allSettled([getChatters(), getVips(), getModerators()]);
    if (results[0].status === 'fulfilled') setChatters(results[0].value.chatters);
    if (results[1].status === 'fulfilled') setVips(results[1].value);
    if (results[2].status === 'fulfilled') setMods(results[2].value);
    const failure = results.find(r => r.status === 'rejected') as PromiseRejectedResult | undefined;
    if (failure) setError(failure.reason instanceof Error ? failure.reason.message : 'Some viewer data failed to load. Reconnect Twitch if VIP/mod lists are empty.');
  }, []);

  React.useEffect(() => { void refresh(); }, [refresh]);

  const vipSet = new Set(vips.map(v => v.userLogin.toLowerCase()));
  const modSet = new Set(mods.map(m => m.userLogin.toLowerCase()));

  const runAction = (action: () => Promise<{ message: string }>, label: string) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    void action()
      .then(result => setMessage(result.message ?? `Done: ${label}.`))
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : `Could not ${label}.`))
      .finally(() => { setBusy(false); void refresh(); });
  };

  // Merge chatters with anyone who is a VIP/mod but not currently in chat, so the
  // list always shows your whole roster of privileged users.
  const byLogin = new Map<string, Chatter>();
  for (const person of [...chatters, ...vips, ...mods]) byLogin.set(person.userLogin.toLowerCase(), person);
  const term = search.trim().toLowerCase();
  const people = [...byLogin.values()]
    .filter(person => !term || person.userLogin.toLowerCase().includes(term) || person.userName.toLowerCase().includes(term))
    .sort((a, b) => a.userName.localeCompare(b.userName));

  const searchLogin = term.replace(/^@/, '');
  const searchIsNew = searchLogin.length > 0 && !byLogin.has(searchLogin);

  return (
    <div className="settings-page">
      <div className="settings-inner">
        <div className="rewards-header">
          <div>
            <div className="settings-eyebrow">viewers</div>
            <h2 className="settings-title">Viewers</h2>
            <p className="set-intro">Grant VIP or moderator, or moderate any viewer. Current chatters, VIPs, and mods are listed. Search a username to act on someone who is not in chat.</p>
          </div>
          <button className="modbtn" type="button" disabled={busy} onClick={() => void refresh()}>Refresh</button>
        </div>

        {error ? <div className="set-status error">{error}</div> : null}
        {message ? <div className="set-status">{message}</div> : null}

        <div className="set-group">
          <label className="field">
            <span>Search or enter a username</span>
            <input
              value={search}
              placeholder="username"
              disabled={busy}
              onChange={event => setSearch(event.target.value)}
            />
          </label>
          {searchIsNew && (
            <ViewerRow
              login={searchLogin}
              name={searchLogin}
              role={roleFor(searchLogin, vipSet, modSet)}
              busy={busy}
              onAction={runAction}
            />
          )}
        </div>

        <div className="set-group">
          <div className="set-group-label">People ({people.length})</div>
          {people.length === 0 ? (
            <div className="reward-empty">No viewers to show yet.</div>
          ) : people.map(person => (
            <ViewerRow
              key={person.userLogin}
              login={person.userLogin}
              name={person.userName}
              role={roleFor(person.userLogin.toLowerCase(), vipSet, modSet)}
              busy={busy}
              onAction={runAction}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Render the page in Dashboard.tsx**

Add the import near the other page imports:

```tsx
import { ViewersPage } from './ViewersPage';
```

In the render block, add a `viewers` branch before the final `SettingsPage` fallback (extending the chain from Task 5):

```tsx
      ) : page === 'categories' ? (
        <StreamCategoriesPage onBack={() => changePage('settings')} />
      ) : page === 'viewers' ? (
        <ViewersPage />
      ) : (
        <SettingsPage
```

- [ ] **Step 4: Add minimal styling**

In `src/client/styles/panel.css`, append:

```css
.viewer-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 0;
  border-top: 1px solid var(--border-1, rgba(255, 255, 255, 0.08));
}
.viewer-row:first-of-type { border-top: none; }
.viewer-row-main { display: flex; align-items: center; gap: 8px; }
.viewer-row-actions { display: flex; flex-wrap: wrap; gap: 6px; }
```

- [ ] **Step 5: Full verification + browser check**

Run: `bun run typecheck && bun test && bun run build`
Expected: all pass.
Then with `bun run dev` and Twitch reconnected (new scopes granted): open `http://localhost:5173/viewers`. Expected: current chatters/VIPs/mods listed with role badges; VIP/Mod/Un-VIP/Un-Mod, Shoutout, Timeout, Ban work; searching a username not in chat shows an actionable row. Twitch's own errors (e.g. "can't mod a VIP") surface as the red status message.

- [ ] **Step 6: Commit**

```bash
git add src/client/services/dashboard.ts src/client/pages/Dashboard.tsx src/client/pages/ViewersPage.tsx src/client/styles/panel.css
git commit -m "feat: add viewers page with VIP and moderator controls

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification

- [ ] Run the full gate once more: `bun run typecheck && bun test && bun run build` — all pass.
- [ ] Browser pass across the four surfaces: `/tablet` (A), `/settings/categories` (B/C), Stream Info modal tag auto-apply (B), `/viewers` (D).
- [ ] Confirm the "Reconnect Twitch" prompt appears until the two new scopes are granted, then VIP/mod actions succeed.

## Spec coverage check

- Feature A (tablet highlight) → Task 1.
- Feature B (category management + per-category tags auto-apply) → Tasks 3 (store), 5 (page), 6 (auto-apply, Replace behavior).
- Feature C (tag search fix) → Tasks 2 (history store), 4 (suggestions rewrite).
- Feature D (VIP/mod + Viewers page) → Tasks 7 (endpoints + scopes), 8 (page).
- Feature E (Twitch-managed rewards) → intentionally no task (documented Twitch limitation).

## Notes / decisions baked in

- Tag apply is **Replace**, and only when the picked category has ≥1 saved tag (never wipes tags for an untagged category).
- New scopes require **one Twitch reconnect**; endpoints return a clear 403 until then.
- Viewers has no dedicated `*.test.ts` — it is thin I/O wrapping, matching `chatters.ts` (also untested); its gate is typecheck/build/browser. The logic-heavy tag/category code is unit-tested (Tasks 2, 3).
- `routing.ts`, `shell.tsx`, and `Dashboard.tsx` are each touched across Tasks 5 and 8; Task 5 adds the `viewers` route/nav entry up front so those files are edited once for routing and once for rendering.
