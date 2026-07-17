import type express from 'express';
import type { MediaMuteState } from '../shared/api';
import { db } from './db';
import { broadcast } from './realtime';

/**
 * The master "mute sound/video commands" switch. A single row (id = 1) so it
 * persists across restart — a mid-stream restart must not silently un-mute. The
 * executor reads getMediaMuted() and skips any quick-disable Action while it is on.
 *
 * Deliberately off the app_config / Settings path: a mute must never trigger a
 * Twitch/OBS reconnect, and it is flipped from a Stream Controls button, not the
 * credentials form.
 */
const readRow = db.prepare('select muted from media_mute where id = 1');
const writeRow = db.prepare(
  'insert into media_mute (id, muted) values (1, ?) on conflict(id) do update set muted = excluded.muted',
);

export function getMediaMuted(): boolean {
  const row = readRow.get() as { muted: number } | null;
  return row?.muted === 1;
}

export function setMediaMuted(muted: boolean): MediaMuteState {
  writeRow.run(muted ? 1 : 0);
  const state: MediaMuteState = { muted };
  // Dashboard and tablet seed from the GET on load and track this event afterwards,
  // so every operator surface reflects the switch without a manual refresh.
  broadcast('media:mute', state);
  return state;
}

/**
 * Operator-only: requireDashboardToken already gates /api. This is never on the
 * overlay token's read allowlist — a browser source has no business reading or
 * flipping the mute.
 */
export function registerMediaMuteRoutes(app: express.Express) {
  app.get('/api/automation/media-mute', (_request, response) => {
    response.json({ muted: getMediaMuted() } satisfies MediaMuteState);
  });

  app.put('/api/automation/media-mute', (request, response) => {
    const muted = (request.body as { muted?: unknown } | null)?.muted === true;
    response.json(setMediaMuted(muted));
  });
}
