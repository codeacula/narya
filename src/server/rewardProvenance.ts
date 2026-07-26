import { db } from './db';
import { HttpRouteError } from './http';
import { isKnownSource } from './apps';

const getRow = db.prepare('select source from reward_provenance where reward_id = ?');
const upsert = db.prepare(`
  insert into reward_provenance (reward_id, source, external_ref, created_at)
  values (?, ?, ?, ?)
  on conflict(reward_id) do update set source = excluded.source
`);
const insertIfMissing = db.prepare(`
  insert into reward_provenance (reward_id, source, external_ref, created_at)
  values (?, 'manual', null, ?)
  on conflict(reward_id) do nothing
`);
const deleteRow = db.prepare('delete from reward_provenance where reward_id = ?');
const ownsRow = db.prepare('select 1 as present from reward_provenance where reward_id = ? and source = ?');
const listIdsBySource = db.prepare('select reward_id as rewardId from reward_provenance where source = ?');
const findByExternalRef = db.prepare(
  'select reward_id as rewardId from reward_provenance where source = ? and external_ref = ?'
);
// No on conflict(source, external_ref) clause here on purpose: only the primary-key
// conflict (re-writing the same reward_id, e.g. an idempotent retry) is handled.
// A second reward_id claiming an already-used (source, external_ref) pair hits the
// partial unique index and SQLite throws — that failure must reach the caller
// (the route decides the HTTP response) rather than being swallowed here.
const upsertWithRef = db.prepare(`
  insert into reward_provenance (reward_id, source, external_ref, created_at)
  values (?, ?, ?, ?)
  on conflict(reward_id) do update set source = excluded.source, external_ref = excluded.external_ref
`);
const countsBySource = db.prepare('select source, count(*) as count from reward_provenance group by source');

export function getRewardSource(rewardId: string): string | null {
  const row = getRow.get(rewardId) as { source: string } | undefined;
  return row?.source ?? null;
}

export function setRewardSource(rewardId: string, source: string): void {
  if (!isKnownSource(source)) throw new HttpRouteError(400, `Unknown reward source "${source}".`);
  upsert.run(rewardId, source, null, new Date().toISOString());
}

/** Insert source='manual' for a reward id we have never seen. Never overwrites an existing source. */
export function ensureManualProvenance(rewardId: string): void {
  insertIfMissing.run(rewardId, new Date().toISOString());
}

export function clearRewardSource(rewardId: string): void {
  deleteRow.run(rewardId);
}

/** The isolation primitive: true only when this exact reward is attributed to this
 *  exact source. Every /api/ext/ route gates on it, because Twitch cannot — every
 *  narya-created reward is manageable by our single client_id regardless of app.
 *  An unknown reward id (no provenance row at all) is never owned by anyone. */
export function ownsReward(rewardId: string, source: string): boolean {
  return Boolean(ownsRow.get(rewardId, source));
}

export function listRewardIdsBySource(source: string): string[] {
  return (listIdsBySource.all(source) as { rewardId: string }[]).map(row => row.rewardId);
}

/** Scoped by source, so the same external_ref reused by two different apps (or by
 *  an app and 'manual'/'narya') resolves independently — each source's idempotency
 *  key is its own namespace. */
export function findRewardByExternalRef(source: string, externalRef: string): string | null {
  const row = findByExternalRef.get(source, externalRef) as { rewardId: string } | undefined;
  return row?.rewardId ?? null;
}

/** Like setRewardSource, but also records the external_ref that makes this write
 *  idempotent. Deliberately does not catch the unique-constraint error raised when
 *  another reward_id already holds this (source, external_ref) pair — the caller
 *  decides what that means. */
export function setRewardSourceWithRef(rewardId: string, source: string, externalRef: string): void {
  if (!isKnownSource(source)) throw new HttpRouteError(400, `Unknown reward source "${source}".`);
  upsertWithRef.run(rewardId, source, externalRef, new Date().toISOString());
}

/** Per-source reward counts across every source that has ever been written,
 *  including 'manual' and 'narya' — omits none. */
export function rewardCountsBySource(): Record<string, number> {
  const rows = countsBySource.all() as { source: string; count: number }[];
  const result: Record<string, number> = {};
  for (const row of rows) result[row.source] = row.count;
  return result;
}
