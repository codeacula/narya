import type express from 'express';
import type { OverlayAdBreak } from '../shared/api';
import { broadcast } from './realtime';
import type { RuntimeState } from './runtime';

/**
 * What the overlay may know about an ad break: when it ends, nothing more. The next ad
 * time, preroll and snooze stay on the operator's DashboardStatus.
 *
 * An end time already in the past is null. `adBreakEndsAt` is only cleared lazily (on
 * the next dashboard status read), so a source that loaded after the break ended would
 * otherwise be told about a break that is over.
 */
export function getOverlayAdBreak(state: Pick<RuntimeState, 'adBreakEndsAt'>, nowMs = Date.now()): OverlayAdBreak {
  const endsAtMs = state.adBreakEndsAt ? new Date(state.adBreakEndsAt).getTime() : Number.NaN;
  if (!Number.isFinite(endsAtMs) || endsAtMs <= nowMs) return { endsAt: null };
  return { endsAt: new Date(endsAtMs).toISOString() };
}

/** Push the current state to overlay sources. Called wherever adBreakEndsAt changes. */
export function broadcastOverlayAdBreak(state: Pick<RuntimeState, 'adBreakEndsAt'>) {
  broadcast('overlay:ad-break', getOverlayAdBreak(state));
}

export function registerOverlayAdRoutes(app: express.Express, state: RuntimeState) {
  app.get('/api/overlay/ad-break', (_request, response) => {
    response.json(getOverlayAdBreak(state));
  });
}
