import React from 'react';
import type { OverlayPlaceholders } from '../shared/api';
import { useSocket, useSocketReconnect } from './realtime';
import { getOverlayPlaceholders, updateOverlayPlaceholders } from './services/dashboard';

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

/**
 * The operator's switch for the outlines, living in the nav bar's Display panel.
 *
 * It used to sit in the dashboard's Stream Controls panel, which the cockpit mounts
 * only when OBS is connected — so the control for positioning OBS sources vanished
 * exactly when OBS was down, despite the flag having nothing to do with OBS. The
 * Display panel is always reachable.
 *
 * Loud while it is on, because it is drawing boxes over whatever OBS is composing.
 * The server holds the flag in memory only, so a restart clears it, but a restart is
 * not something to rely on mid-session — hence the warning rather than silence.
 */
export function OverlayBoundsToggle() {
  // Shares the hook with the overlays themselves, so the switch and the sources can
  // never disagree, and it inherits the refetch-on-reconnect the old copy lacked.
  const enabled = useOverlayPlaceholders();
  const [busy, setBusy] = React.useState(false);

  const toggle = (next: boolean) => {
    setBusy(true);
    // No local state to set: the PUT broadcasts `overlay:placeholders`, and the hook
    // above is already subscribed to it.
    updateOverlayPlaceholders(next)
      .catch(() => undefined)
      .finally(() => setBusy(false));
  };

  return (
    <div className="twk-overlay-bounds">
      <label className="twk-toggle">
        <input
          type="checkbox"
          checked={enabled}
          disabled={busy}
          onChange={event => toggle(event.target.checked)}
        />
        <span>Show overlay bounds</span>
      </label>
      {enabled && (
        <p className="twk-warn" role="status">
          Outlines are visible in every overlay source — turn this off before going live.
        </p>
      )}
    </div>
  );
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
