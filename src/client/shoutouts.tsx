import React from 'react';
import type { SessionShoutout, StreamEvent } from '../shared/api';
import { useSocket } from './realtime';
import { getSessionShoutouts } from './services/dashboard';

const SHOUTOUT_REFRESH_MS = 60_000;
const SHOUTOUT_ROTATE_MS = 5_000;
const SHOUTOUT_FADE_MS = 400;

const KIND_VERB: Record<string, string> = {
  follow: 'followed',
  sub: 'subscribed',
  gift: 'gifted subs',
  cheer: 'cheered',
  raid: 'raided',
  redeem: 'redeemed',
};

/** Reads the current session's roster, refreshing when a new stream event lands. */
export function useSessionShoutouts() {
  const [shoutouts, setShoutouts] = React.useState<SessionShoutout[]>([]);

  const refresh = React.useCallback(() => {
    void getSessionShoutouts().then(setShoutouts).catch((error: unknown) => {
      console.error('Failed to load session shoutouts:', error);
    });
  }, []);

  React.useEffect(() => {
    refresh();
    const timer = setInterval(refresh, SHOUTOUT_REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  useSocket<StreamEvent>('stream:event', React.useCallback(() => { refresh(); }, [refresh]));

  return shoutouts;
}

/** Phrase every kind a person contributed: "subscribed & cheered". */
export function shoutoutVerb(kinds: string[]): string {
  const verbs = kinds.map(kind => KIND_VERB[kind] ?? kind);
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
    if (ordered.length === 0) return;
    setIndex(current => (current < ordered.length ? current : 0));
  }, [ordered.length]);

  React.useEffect(() => {
    if (ordered.length <= 1) return;
    const rotate = setInterval(() => {
      setVisible(false);
      setTimeout(() => {
        setIndex(current => (current + 1) % ordered.length);
        setVisible(true);
      }, SHOUTOUT_FADE_MS);
    }, SHOUTOUT_ROTATE_MS);
    return () => clearInterval(rotate);
  }, [ordered.length]);

  const current = ordered[index];
  if (!current) return null;

  return (
    <div className="shoutoutTicker">
      <div className="shoutoutLabel">thanks to</div>
      <div className={'shoutoutCard' + (visible ? ' isVisible' : '')}>
        <div className="shoutoutName">{current.actor}</div>
        <div className="shoutoutVerb">{shoutoutVerb(current.kinds)}</div>
      </div>
      {ordered.length > 1 && (
        <div className="shoutoutCount">{index + 1} / {ordered.length}</div>
      )}
    </div>
  );
}
