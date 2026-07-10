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
const maxTagStamp = db.prepare(`select max(last_used_at) as maxStamp from stream_tag_history`);

// ISO timestamps only resolve to the millisecond, so two records in the same tick
// would tie and make "most recent" ordering undefined. Issue strictly-increasing
// stamps by starting past the persisted max — restart-safe, and correct within a batch.
function nextStamps(count: number): string[] {
  const current = (maxTagStamp.get() as { maxStamp: string | null }).maxStamp;
  const floor = current ? Date.parse(current) : 0;
  let base = Date.now();
  if (Number.isFinite(floor) && floor >= base) base = floor + 1;
  return Array.from({ length: count }, (_, index) => new Date(base + index).toISOString());
}

// Remember every tag the streamer actually uses — Twitch no longer exposes a tag
// search API, so this local history is the only real source of autocomplete.
export function recordTagHistory(tags: string[]): void {
  const normalized = tags.map(normalizeTag).filter(tag => tag.length > 0);
  if (normalized.length === 0) return;
  const stamps = nextStamps(normalized.length);
  normalized.forEach((tag, index) => upsertTagHistory.run(tag.toLowerCase(), tag, stamps[index]));
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
