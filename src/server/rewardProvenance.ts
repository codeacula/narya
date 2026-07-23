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
