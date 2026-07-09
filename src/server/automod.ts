import type { AutomodHold, AutomodQueue } from '../shared/api';
import { appendChatEvent } from './chat';
import { db } from './db';
import { broadcast } from './realtime';

const RESOLVED_HISTORY_WINDOW_MS = 15 * 60 * 1000;
const RESOLVED_HISTORY_LIMIT = 20;
// Safety cap so a hold-spam wave can't make the pending payload unbounded.
const PENDING_LIMIT = 200;
// Twitch auto-expires held messages well inside an hour; sweep anything older
// than this conservative bound so holds whose `update` event we missed (server
// down / socket drop) don't linger pending forever. The allow/deny routes
// independently reconcile holds Twitch has already expired.
const HOLD_EXPIRY_WINDOW_MS = 2 * 60 * 60 * 1000;

// Shared projection so the AutomodHold column aliasing lives in exactly one place.
const automodHoldColumns = `
  id, channel, username,
  display_name as displayName,
  message, category, level,
  held_at as heldAt,
  resolved_at as resolvedAt,
  resolution,
  resolved_by as resolvedBy
`;

const insertAutomodHold = db.prepare(`
  insert or ignore into automod_holds
    (id, channel, username, display_name, message, category, level, held_at, resolved_at, resolution, resolved_by)
  values
    (?, ?, ?, ?, ?, ?, ?, ?, null, null, null)
`);

const resolveAutomodHoldRow = db.prepare(`
  update automod_holds
  set resolved_at = ?, resolution = ?, resolved_by = ?
  where id = ? and resolved_at is null
`);

const getAutomodHoldRow = db.prepare(`select ${automodHoldColumns} from automod_holds where id = ?`);

const listPendingAutomodHolds = db.prepare(
  `select ${automodHoldColumns} from automod_holds where resolved_at is null order by held_at asc limit ?`,
);

const listRecentlyResolvedAutomodHolds = db.prepare(
  `select ${automodHoldColumns} from automod_holds where resolved_at is not null and resolved_at >= ? order by resolved_at desc limit ?`,
);

const listStalePendingHoldIds = db.prepare(
  `select id from automod_holds where resolved_at is null and held_at < ?`,
);

export function recordAutomodHold(hold: {
  id: string;
  channel: string;
  username: string;
  displayName: string;
  message: string;
  category: string | null;
  level: number | null;
  heldAt: string;
}): AutomodHold {
  const result = insertAutomodHold.run(
    hold.id,
    hold.channel,
    hold.username,
    hold.displayName,
    hold.message,
    hold.category,
    hold.level,
    hold.heldAt,
  ) as { changes: number };
  const row = getAutomodHoldRow.get(hold.id) as AutomodHold | null;
  if (result.changes > 0 && row) {
    appendChatEvent('automod.hold', hold.channel, hold, {
      messageId: hold.id,
      username: hold.username,
      occurredAt: hold.heldAt,
    });
    broadcast('automod:held', row);
  }
  return row as AutomodHold;
}

export function getAutomodHold(id: string): AutomodHold | null {
  return (getAutomodHoldRow.get(id) as AutomodHold | null) ?? null;
}

export function resolveAutomodHold(
  id: string,
  resolution: 'allowed' | 'denied' | 'expired',
  resolvedBy: string | null,
): AutomodHold | null {
  const resolvedAt = new Date().toISOString();
  const result = resolveAutomodHoldRow.run(resolvedAt, resolution, resolvedBy, id) as { changes: number };
  const row = getAutomodHoldRow.get(id) as AutomodHold | null;
  if (result.changes > 0 && row) {
    appendChatEvent('automod.resolve', row.channel, { resolution, resolvedBy }, {
      messageId: id,
      username: row.username,
      occurredAt: resolvedAt,
    });
    broadcast('automod:resolved', row);
  }
  return row;
}

// Mark pending holds Twitch has almost certainly already expired as expired
// locally, reusing resolveAutomodHold so each still broadcasts + audits.
export function sweepExpiredHolds(): void {
  const cutoff = new Date(Date.now() - HOLD_EXPIRY_WINDOW_MS).toISOString();
  const stale = listStalePendingHoldIds.all(cutoff) as Array<{ id: string }>;
  for (const { id } of stale) {
    resolveAutomodHold(id, 'expired', null);
  }
}

export function getAutomodQueue(): AutomodQueue {
  sweepExpiredHolds();
  const since = new Date(Date.now() - RESOLVED_HISTORY_WINDOW_MS).toISOString();
  return {
    pending: listPendingAutomodHolds.all(PENDING_LIMIT) as AutomodHold[],
    recentlyResolved: listRecentlyResolvedAutomodHolds.all(since, RESOLVED_HISTORY_LIMIT) as AutomodHold[],
  };
}
