import type express from 'express';
import type { HoldingScene, HoldingScenesState } from '../shared/api';
import { db } from './db';
import { HttpRouteError, handle } from './http';
import { broadcast } from './realtime';

const MINUTE_MS = 60_000;
export const MIN_COUNTDOWN_MINUTES = 1;
export const MAX_COUNTDOWN_MINUTES = 240;
export const MAX_NEXT_STREAM_LENGTH = 140;

type Row = { startingEndsAt: string | null; brbEndsAt: string | null; nextStream: string };

const selectRow = db.prepare(`
  select starting_ends_at as startingEndsAt, brb_ends_at as brbEndsAt, next_stream as nextStream
  from holding_scenes where id = 1
`);

// One statement per column rather than a dynamic column name: the scene comes from a
// request body, and a fixed statement per scene keeps it out of the SQL text entirely.
const writeEndsAt: Record<HoldingScene, ReturnType<typeof db.prepare>> = {
  starting: db.prepare(`
    insert into holding_scenes (id, starting_ends_at, updated_at) values (1, ?, ?)
    on conflict(id) do update set starting_ends_at = excluded.starting_ends_at, updated_at = excluded.updated_at
  `),
  brb: db.prepare(`
    insert into holding_scenes (id, brb_ends_at, updated_at) values (1, ?, ?)
    on conflict(id) do update set brb_ends_at = excluded.brb_ends_at, updated_at = excluded.updated_at
  `),
};

const writeNextStream = db.prepare(`
  insert into holding_scenes (id, next_stream, updated_at) values (1, ?, ?)
  on conflict(id) do update set next_stream = excluded.next_stream, updated_at = excluded.updated_at
`);

/**
 * What the overlay may know: two end times and one line of display text.
 *
 * Built field by field, not spread from the row — this reaches the overlay role over
 * both REST and the broadcast, and broadcasts are filtered by event name only, so a
 * column added to the table later must not propagate to a browser source by accident.
 */
export function getHoldingScenes(): HoldingScenesState {
  const row = selectRow.get() as Row | null;
  return {
    startingEndsAt: row?.startingEndsAt ?? null,
    brbEndsAt: row?.brbEndsAt ?? null,
    nextStream: row?.nextStream ?? '',
  };
}

function publish(): HoldingScenesState {
  const state = getHoldingScenes();
  broadcast('overlay:holding-scenes', state);
  return state;
}

function parseScene(value: unknown): HoldingScene {
  if (value === 'starting' || value === 'brb') return value;
  throw new HttpRouteError(400, "scene must be 'starting' or 'brb'");
}

function parseWholeMinutes(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new HttpRouteError(400, `${label} must be a whole number of minutes`);
  }
  return value;
}

function endsAtOf(state: HoldingScenesState, scene: HoldingScene): string | null {
  return scene === 'starting' ? state.startingEndsAt : state.brbEndsAt;
}

/** Start a countdown of `minutes` from now, or clear it with null. */
export function setHoldingCountdown(sceneInput: unknown, minutes: unknown, nowMs = Date.now()): HoldingScenesState {
  const scene = parseScene(sceneInput);
  let endsAt: string | null = null;
  if (minutes !== null) {
    const whole = parseWholeMinutes(minutes, 'minutes');
    if (whole < MIN_COUNTDOWN_MINUTES || whole > MAX_COUNTDOWN_MINUTES) {
      throw new HttpRouteError(400, `minutes must be between ${MIN_COUNTDOWN_MINUTES} and ${MAX_COUNTDOWN_MINUTES}`);
    }
    endsAt = new Date(nowMs + whole * MINUTE_MS).toISOString();
  }
  writeEndsAt[scene].run(endsAt, new Date(nowMs).toISOString());
  return publish();
}

/**
 * Move a running countdown's end time by `deltaMinutes`. Only meaningful while one is
 * set — adjusting nothing is a 409, not a silent new countdown. The result is clamped
 * to within the settable range of now (either side, since an overdue countdown is
 * legitimately in the past) so repeated nudges cannot walk it to an absurd timestamp.
 */
export function adjustHoldingCountdown(sceneInput: unknown, deltaMinutes: unknown, nowMs = Date.now()): HoldingScenesState {
  const scene = parseScene(sceneInput);
  const delta = parseWholeMinutes(deltaMinutes, 'deltaMinutes');
  if (delta === 0 || Math.abs(delta) > MAX_COUNTDOWN_MINUTES) {
    throw new HttpRouteError(400, `deltaMinutes must be non-zero and within ±${MAX_COUNTDOWN_MINUTES}`);
  }
  const current = endsAtOf(getHoldingScenes(), scene);
  const currentMs = current ? new Date(current).getTime() : Number.NaN;
  if (!Number.isFinite(currentMs)) {
    throw new HttpRouteError(409, `No ${scene} countdown is set to adjust`);
  }
  const span = MAX_COUNTDOWN_MINUTES * MINUTE_MS;
  const nextMs = Math.min(nowMs + span, Math.max(nowMs - span, currentMs + delta * MINUTE_MS));
  writeEndsAt[scene].run(new Date(nextMs).toISOString(), new Date(nowMs).toISOString());
  return publish();
}

/** The Ending scene's "next stream" line: trimmed and capped; empty clears it. */
export function setNextStream(text: unknown, nowMs = Date.now()): HoldingScenesState {
  if (typeof text !== 'string') throw new HttpRouteError(400, 'text must be a string');
  writeNextStream.run(text.trim().slice(0, MAX_NEXT_STREAM_LENGTH), new Date(nowMs).toISOString());
  return publish();
}

export function registerHoldingSceneRoutes(app: express.Express) {
  // On OVERLAY_PATHS in auth.ts: the holding scenes seed themselves from it.
  app.get('/api/overlay/holding-scenes', (_request, response) => {
    response.json(getHoldingScenes());
  });

  // The writes are deliberately NOT on OVERLAY_PATHS, so the overlay token (GET-only)
  // is refused: a browser source must not be able to set every other source's clock.
  app.put('/api/holding-scenes/countdown', handle((request, response) => {
    const body = (request.body ?? {}) as { scene?: unknown; minutes?: unknown };
    response.json(setHoldingCountdown(body.scene, body.minutes === undefined ? Number.NaN : body.minutes));
  }));

  app.post('/api/holding-scenes/countdown/adjust', handle((request, response) => {
    const body = (request.body ?? {}) as { scene?: unknown; deltaMinutes?: unknown };
    response.json(adjustHoldingCountdown(body.scene, body.deltaMinutes));
  }));

  app.put('/api/holding-scenes/next-stream', handle((request, response) => {
    response.json(setNextStream((request.body as { text?: unknown } | null)?.text));
  }));
}
