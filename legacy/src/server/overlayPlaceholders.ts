import type express from 'express';
import type { OverlayPlaceholders } from '../shared/api';
import { broadcast } from './realtime';

/**
 * Whether overlay browser sources should draw their bounds.
 *
 * In memory on purpose. An overlay source is invisible until an event fires, which
 * is what makes this toggle necessary — and it is also what makes leaving it on
 * dangerous: the boxes would sit on a live stream. Keeping the flag out of the
 * database means the worst case is that a restart silently turns it off, which
 * costs the operator a click, rather than silently leaving it on, which costs them
 * a broadcast.
 */
let enabled = false;

export function getOverlayPlaceholders(): OverlayPlaceholders {
  return { enabled };
}

export function setOverlayPlaceholders(body: unknown): OverlayPlaceholders {
  enabled = (body as { enabled?: unknown } | null)?.enabled === true;
  const state = getOverlayPlaceholders();
  // Overlays seed from the GET on load and track this event afterwards, so a source
  // that was already open updates without an OBS refresh.
  broadcast('overlay:placeholders', state);
  return state;
}

export function registerOverlayPlaceholderRoutes(app: express.Express) {
  app.get('/api/overlay/placeholders', (_request, response) => {
    response.json(getOverlayPlaceholders());
  });

  app.put('/api/overlay/placeholders', (request, response) => {
    response.json(setOverlayPlaceholders(request.body));
  });
}
