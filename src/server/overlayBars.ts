import type express from 'express';
import type { LatestEvent, LatestEvents, OverlayStreamSession } from '../shared/api';
import { db } from './db';
import { broadcast } from './realtime';
import { getActiveStreamSession } from './streamSession';

type LatestRow = { actor: string; amount: number | null };

// Latest EVER, deliberately not scoped to the session: the bar should be populated the
// moment a stream starts, and "latest follower" is still true after the stream ends.
// A flushed viewer's name must not stay on stream: rows whose actor_login is on the
// ignore list are skipped, so "latest" falls back to the previous real event. Rows with
// no actor_login (older rows, anonymous events) still count.
// Gifts count as subs here — a gifted sub is the sub the channel last got.
const selectLatestFollow = db.prepare(`
  select actor, amount from stream_events where kind = 'follow'
    and (actor_login is null or actor_login not in (select login from ignored_logins))
  order by received_at desc limit 1
`);
const selectLatestSub = db.prepare(`
  select actor, amount from stream_events where kind in ('sub', 'gift')
    and (actor_login is null or actor_login not in (select login from ignored_logins))
  order by received_at desc limit 1
`);
const selectLatestCheer = db.prepare(`
  select actor, amount from stream_events where kind = 'cheer'
    and (actor_login is null or actor_login not in (select login from ignored_logins))
  order by received_at desc limit 1
`);
const selectLatestRaid = db.prepare(`
  select actor, amount from stream_events where kind = 'raid'
    and (actor_login is null or actor_login not in (select login from ignored_logins))
  order by received_at desc limit 1
`);

function toLatest(row: unknown, withAmount: boolean): LatestEvent | null {
  if (!row) return null;
  const { actor, amount } = row as LatestRow;
  // Field by field: this reaches the overlay role, so nothing else on the row
  // (ids, logins, session ids, detail) may ride along by accident.
  return { name: actor, amount: withAmount && typeof amount === 'number' ? amount : null };
}

export function getLatestEvents(): LatestEvents {
  return {
    follow: toLatest(selectLatestFollow.get(), false),
    // Name only: for a gift the gifter, with no count, so a sub and a gift read alike.
    sub: toLatest(selectLatestSub.get(), false),
    cheer: toLatest(selectLatestCheer.get(), true),
    raid: toLatest(selectLatestRaid.get(), true),
  };
}

/**
 * Tell every open top bar to take the new value. Called after a flush or unflush, which
 * change what "latest" means without any new stream event arriving to trigger a refetch.
 */
export function broadcastLatestEvents(): void {
  broadcast('overlay:latest-events', getLatestEvents());
}

export function getOverlayStreamSession(): OverlayStreamSession {
  return { startedAt: getActiveStreamSession()?.startedAt ?? null };
}

export function registerOverlayBarRoutes(app: express.Express) {
  app.get('/api/overlay/latest-events', (_request, response) => {
    response.json(getLatestEvents());
  });

  app.get('/api/overlay/stream-session', (_request, response) => {
    response.json(getOverlayStreamSession());
  });
}
