import type { AutomodHold } from '../shared/api';
import { appendChatEvent } from './chat';
import { db } from './db';
import { broadcast } from './realtime';

const RESOLVED_HISTORY_WINDOW_MS = 15 * 60 * 1000;
const RESOLVED_HISTORY_LIMIT = 20;

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

const getAutomodHoldRow = db.prepare(`
  select
    id, channel, username,
    display_name as displayName,
    message, category, level,
    held_at as heldAt,
    resolved_at as resolvedAt,
    resolution,
    resolved_by as resolvedBy
  from automod_holds
  where id = ?
`);

const listPendingAutomodHolds = db.prepare(`
  select
    id, channel, username,
    display_name as displayName,
    message, category, level,
    held_at as heldAt,
    resolved_at as resolvedAt,
    resolution,
    resolved_by as resolvedBy
  from automod_holds
  where resolved_at is null
  order by held_at asc
`);

const listRecentlyResolvedAutomodHolds = db.prepare(`
  select
    id, channel, username,
    display_name as displayName,
    message, category, level,
    held_at as heldAt,
    resolved_at as resolvedAt,
    resolution,
    resolved_by as resolvedBy
  from automod_holds
  where resolved_at is not null and resolved_at >= ?
  order by resolved_at desc
  limit ?
`);

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
  insertAutomodHold.run(
    hold.id,
    hold.channel,
    hold.username,
    hold.displayName,
    hold.message,
    hold.category,
    hold.level,
    hold.heldAt,
  );
  appendChatEvent('automod.hold', hold.channel, hold, {
    messageId: hold.id,
    username: hold.username,
    occurredAt: hold.heldAt,
  });
  const row = getAutomodHoldRow.get(hold.id) as AutomodHold;
  broadcast('automod:held', row);
  return row;
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

export function getAutomodQueue(): { pending: AutomodHold[]; recentlyResolved: AutomodHold[] } {
  const since = new Date(Date.now() - RESOLVED_HISTORY_WINDOW_MS).toISOString();
  return {
    pending: listPendingAutomodHolds.all() as AutomodHold[],
    recentlyResolved: listRecentlyResolvedAutomodHolds.all(since, RESOLVED_HISTORY_LIMIT) as AutomodHold[],
  };
}
