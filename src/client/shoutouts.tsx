import React from 'react';
import type { SessionShoutout, StreamEvent } from '../shared/api';
import { ATTENTION_EVENT_KINDS, kindVerb } from './eventKinds';
import { useSocket } from './realtime';
import { getSessionShoutouts } from './services/dashboard';

const SHOUTOUT_REFRESH_MS = 60_000;
const SHOUTOUT_ROTATE_MS = 5_000;
const SHOUTOUT_FADE_MS = 400;
/** A raid lands dozens of follows at once; coalesce them into one refetch. */
const SHOUTOUT_DEBOUNCE_MS = 2_000;

/**
 * Reads the current session's roster, refreshing when a thank-worthy event lands
 * and whenever the session itself changes (go live / go offline). The whole
 * session is aggregated server-side, so refetches are debounced.
 */
export function useSessionShoutouts(sessionId: string | null = null) {
  const [shoutouts, setShoutouts] = React.useState<SessionShoutout[]>([]);
  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = React.useCallback(() => {
    void getSessionShoutouts().then(setShoutouts).catch((error: unknown) => {
      console.error('Failed to load session shoutouts:', error);
    });
  }, []);

  const refreshSoon = React.useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(refresh, SHOUTOUT_DEBOUNCE_MS);
  }, [refresh]);

  React.useEffect(() => {
    refresh();
    const timer = setInterval(refresh, SHOUTOUT_REFRESH_MS);
    return () => {
      clearInterval(timer);
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [refresh, sessionId]);

  // An ad break can't change the roster, so it isn't worth a round-trip.
  useSocket<StreamEvent>('stream:event', React.useCallback((event) => {
    if (ATTENTION_EVENT_KINDS.has(event.kind)) refreshSoon();
  }, [refreshSoon]));

  return shoutouts;
}

/** Phrase every kind a person contributed: "subscribed & cheered". */
export function shoutoutVerb(kinds: string[]): string {
  const verbs = kinds.map(kindVerb);
  if (verbs.length <= 1) return verbs[0] ?? '';
  return `${verbs.slice(0, -1).join(', ')} & ${verbs[verbs.length - 1]}`;
}

/**
 * Rotates one name at a time so the widget stays small enough to tuck into a
 * scene corner. Renders nothing when the roster is empty, keeping the browser
 * source fully transparent off-stream.
 */
export function ShoutoutTicker({ shoutouts }: { shoutouts: SessionShoutout[] }) {
  const [index, setIndex] = React.useState(0);
  const [visible, setVisible] = React.useState(true);

  // Oldest-first reads like a thank-you list rather than a live feed.
  const ordered = React.useMemo(
    () => [...shoutouts].sort((a, b) => a.firstAt.localeCompare(b.firstAt)),
    [shoutouts],
  );

  React.useEffect(() => {
    if (ordered.length <= 1) return;
    let fade: ReturnType<typeof setTimeout> | null = null;
    const rotate = setInterval(() => {
      setVisible(false);
      fade = setTimeout(() => {
        setIndex(current => current + 1);
        setVisible(true);
      }, SHOUTOUT_FADE_MS);
    }, SHOUTOUT_ROTATE_MS);
    return () => {
      clearInterval(rotate);
      // A pending fade would otherwise advance the index after the roster shrank.
      if (fade) clearTimeout(fade);
    };
  }, [ordered.length]);

  // `index` runs unbounded and wraps here, so a shrinking roster can never leave
  // it out of range — no clamping effect, and no blank frame before one fires.
  const current = ordered.length > 0 ? ordered[index % ordered.length] : undefined;
  if (!current) return null;

  return (
    <div className="shoutoutTicker">
      <div className="shoutoutLabel">thanks to</div>
      <div className={'shoutoutCard' + (visible ? ' isVisible' : '')}>
        <div className="shoutoutName">{current.actor}</div>
        <div className="shoutoutVerb">{shoutoutVerb(current.kinds)}</div>
      </div>
      {ordered.length > 1 && (
        <div className="shoutoutCount">{(index % ordered.length) + 1} / {ordered.length}</div>
      )}
    </div>
  );
}
