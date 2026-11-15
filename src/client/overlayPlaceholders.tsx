import React from 'react';
import type { OverlayPlaceholders } from '../shared/api';
import { useSocket, useSocketReconnect } from './realtime';
import { getOverlayPlaceholders, updateOverlayPlaceholders } from './services/dashboard';
import type { LiveValueStatus } from './liveValue';
import { overlayBoundsFace } from './controlFaces';
import { errorMessage } from './errors';
import { ControlProblem } from './ui/controlProblem';

/**
 * REST seed + live `overlay:placeholders` updates, so toggling from the dashboard
 * reaches a browser source that is already open without an OBS refresh.
 *
 * Refetches on socket reconnect: a source that was disconnected while the operator
 * switched the boxes off would otherwise keep drawing them, which is the one state
 * that must not persist.
 *
 * `status` is for the operator's switch. A failed fetch sets `enabled` to false —
 * right for a browser source, wrong to show the operator — and marks the state unknown
 * (`failed`) until a fetch or event lands, even after a reconnect refetch: the value
 * was reset, so it is no longer last-known, it is a guess.
 */
function useOverlayPlaceholdersState(): { enabled: boolean; status: LiveValueStatus; retry: () => void } {
  const [enabled, setEnabled] = React.useState(false);
  const [status, setStatus] = React.useState<LiveValueStatus>('loading');

  const refresh = React.useCallback(() => {
    getOverlayPlaceholders()
      .then(state => {
        setEnabled(state.enabled);
        setStatus('loaded');
      })
      // Fail closed: if we cannot tell, draw nothing rather than risk boxes on stream.
      .catch(() => {
        setEnabled(false);
        setStatus('failed');
      });
  }, []);

  React.useEffect(refresh, [refresh]);
  useSocketReconnect(refresh);

  useSocket<OverlayPlaceholders>(
    'overlay:placeholders',
    React.useCallback((next: OverlayPlaceholders) => {
      setEnabled(next.enabled);
      setStatus('loaded');
    }, []),
  );

  const retry = React.useCallback(() => {
    setStatus(current => (current === 'failed' ? 'loading' : current));
    refresh();
  }, [refresh]);

  return { enabled, status, retry };
}

/** For the browser sources: whether to draw the outlines, false when it cannot tell. */
export function useOverlayPlaceholders(): boolean {
  return useOverlayPlaceholdersState().enabled;
}

/**
 * The operator's switch for the outlines, living in the nav bar's Display panel.
 *
 * It used to sit in the dashboard's Stream Controls panel, which once mounted only
 * when OBS was connected — so the control for positioning OBS sources vanished
 * exactly when OBS was down, despite the flag having nothing to do with OBS. The
 * Display panel is always reachable.
 *
 * Loud while it is on, because it is drawing boxes over whatever OBS is composing.
 * The server holds the flag in memory only, so a restart clears it, but a restart is
 * not something to rely on mid-session — hence the warning rather than silence. And
 * not drawn as "off" when its state could not be read (overlayBoundsFace): that would
 * hide the warning while the boxes may be on.
 */
export function OverlayBoundsToggle() {
  // Shares the hook with the overlays themselves, so the switch and the sources can
  // never disagree, and it inherits the refetch-on-reconnect the old copy lacked.
  const { enabled, status, retry } = useOverlayPlaceholdersState();
  const face = overlayBoundsFace(status, enabled);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const toggle = (next: boolean) => {
    setBusy(true);
    setError(null);
    // No local state to set: the PUT broadcasts `overlay:placeholders`, and the hook
    // above is already subscribed to it.
    updateOverlayPlaceholders(next)
      .catch((caught: unknown) => setError(errorMessage(
        caught,
        next ? 'Could not turn overlay bounds on.' : 'Could not turn overlay bounds off.',
      )))
      .finally(() => setBusy(false));
  };

  return (
    <div className="twk-overlay-bounds">
      <label className="twk-toggle">
        <input
          type="checkbox"
          checked={face.checked}
          disabled={busy || face.locked}
          onChange={event => toggle(event.target.checked)}
        />
        <span>Show overlay bounds</span>
      </label>
      {face.warn && (
        <p className="twk-warn" role="status">
          Outlines are visible in every overlay source — turn this off before going live.
        </p>
      )}
      <ControlProblem
        unreadable={face.unreadable}
        error={error}
        onRetry={retry}
        className="twk-warn twk-problem"
      />
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
  winddown: 'Wind-down countdown',
  topbar: 'Top bar',
  bottombar: 'Bottom bar',
  ads: 'Ad break banner',
  pinned: 'Pinned card',
  starting: 'Starting soon scene',
  brb: 'Be right back scene',
  ending: 'Ending scene',
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
