import React from 'react';
import type { OverlayPlaceholders } from '../shared/api';
import { useSocket, useSocketReconnect } from './realtime';
import { getOverlayPlaceholders } from './services/dashboard';

/**
 * REST seed + live `overlay:placeholders` updates, so toggling from the dashboard
 * reaches a browser source that is already open without an OBS refresh.
 *
 * Refetches on socket reconnect: a source that was disconnected while the operator
 * switched the boxes off would otherwise keep drawing them, which is the one state
 * that must not persist.
 */
export function useOverlayPlaceholders(): boolean {
  const [enabled, setEnabled] = React.useState(false);

  const refresh = React.useCallback(() => {
    getOverlayPlaceholders()
      .then(state => setEnabled(state.enabled))
      // Fail closed: if we cannot tell, draw nothing rather than risk boxes on stream.
      .catch(() => setEnabled(false));
  }, []);

  React.useEffect(refresh, [refresh]);
  useSocketReconnect(refresh);

  useSocket<OverlayPlaceholders>(
    'overlay:placeholders',
    React.useCallback((next: OverlayPlaceholders) => setEnabled(next.enabled), []),
  );

  return enabled;
}

const OVERLAY_LABELS: Record<string, string> = {
  frame: 'Overlay frame',
  chat: 'Chat',
  nowplaying: 'Now playing',
  sounds: 'Sound playback (audio only — no visible output)',
  shoutouts: 'Shoutouts',
  clips: 'Redeem clips & alert media',
  status: 'Stream status',
  text: 'Alert & action text',
  unknown: 'Unknown overlay',
};

/**
 * The positioning aid: an outline of the source's own bounds, plus which overlay it
 * is. Rendered for *every* overlay from a single place in the router rather than by
 * each page, so a new overlay cannot be added without one, and drawn on top of an
 * empty page and a busy one alike — the point is to reveal the source's area, not to
 * stand in for missing content.
 *
 * `pointer-events: none` throughout: an overlay is not interactive, and a box that
 * swallowed clicks would be a nasty surprise in an OBS interact window.
 */
export function OverlayPlaceholder({ name }: { name: string }) {
  const enabled = useOverlayPlaceholders();
  if (!enabled) return null;

  return (
    <div className="overlay-placeholder" aria-hidden="true">
      <span className="overlay-placeholder-label">{OVERLAY_LABELS[name] ?? name}</span>
    </div>
  );
}
