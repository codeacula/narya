import React from 'react';
import type { AutomodHold } from '../shared/api';
import { useSocket, useSocketReconnect } from './realtime';
import { playAutomodAlert } from './sounds';
import { allowAutomodHold, denyAutomodHold, getAutomodQueue } from './services/dashboard';

// Mirrors the server-side pending cap so the two agree on how many holds a
// spam wave can accumulate before the oldest overflow is dropped.
const PENDING_LIMIT = 200;
const RESOLVED_LIMIT = 20;
// A spam wave can deliver many holds in a burst; the alert fires at most once per
// window so it reads as "something needs review" rather than machine-gunning.
const ALERT_THROTTLE_MS = 1500;

export type AutomodQueueController = {
  pending: AutomodHold[];
  recentlyResolved: AutomodHold[];
  error: string | null;
  allow: (id: string) => Promise<void>;
  deny: (id: string) => Promise<void>;
};

export function useAutomodQueue(): AutomodQueueController {
  const [pending, setPending] = React.useState<AutomodHold[]>([]);
  const [recentlyResolved, setRecentlyResolved] = React.useState<AutomodHold[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  // Ids we've already seen resolved — used so a slow initial snapshot can't
  // re-add a hold that a socket event (or our own action) already cleared.
  const resolvedIds = React.useRef<Set<string>>(new Set());
  // When the audible alert last fired, to throttle a burst of holds.
  const lastAlertAt = React.useRef(0);

  const applyResolved = React.useCallback((hold: AutomodHold) => {
    resolvedIds.current.add(hold.id);
    setPending(current => current.filter(h => h.id !== hold.id));
    setRecentlyResolved(current => [hold, ...current.filter(h => h.id !== hold.id)].slice(0, RESOLVED_LIMIT));
  }, []);

  // Fetch the authoritative queue on mount and on every socket reconnect (live
  // events during a disconnect aren't replayed). Pending is server truth minus
  // ids we've locally resolved, so a hold resolved elsewhere while we were
  // offline drops out instead of lingering as a ghost. History is merged so a
  // just-resolved entry isn't briefly dropped.
  const refresh = React.useCallback(() => {
    getAutomodQueue()
      .then(queue => {
        setError(null);
        setPending(queue.pending.filter(h => !resolvedIds.current.has(h.id)).slice(0, PENDING_LIMIT));
        setRecentlyResolved(current => {
          const byId = new Map<string, AutomodHold>();
          for (const h of current) byId.set(h.id, h);
          for (const h of queue.recentlyResolved) if (!byId.has(h.id)) byId.set(h.id, h);
          return [...byId.values()].slice(0, RESOLVED_LIMIT);
        });
      })
      .catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : 'Failed to load AutoMod queue');
      });
  }, []);

  React.useEffect(() => { refresh(); }, [refresh]);
  useSocketReconnect(refresh);

  useSocket<AutomodHold>(
    'automod:held',
    React.useCallback((hold) => {
      if (resolvedIds.current.has(hold.id)) return;
      setPending(current => (current.some(h => h.id === hold.id) ? current : [...current, hold].slice(0, PENDING_LIMIT)));
      // Audible cue so a held message isn't missed while the operator is looking
      // elsewhere. Fires only on live holds (the initial REST snapshot doesn't
      // route through here), and is throttled so a burst doesn't overlap.
      const now = Date.now();
      if (now - lastAlertAt.current >= ALERT_THROTTLE_MS) {
        lastAlertAt.current = now;
        playAutomodAlert();
      }
    }, []),
  );

  useSocket<AutomodHold>(
    'automod:resolved',
    React.useCallback((hold) => applyResolved(hold), [applyResolved]),
  );

  // The POST returns the resolved hold, so apply it directly instead of waiting
  // for the socket broadcast — the item still clears if the socket is down.
  const allow = React.useCallback(async (id: string) => { applyResolved(await allowAutomodHold(id)); }, [applyResolved]);
  const deny = React.useCallback(async (id: string) => { applyResolved(await denyAutomodHold(id)); }, [applyResolved]);

  return { pending, recentlyResolved, error, allow, deny };
}

function AutomodItem({
  hold,
  onAllow,
  onDeny,
}: {
  hold: AutomodHold;
  onAllow: (id: string) => Promise<void>;
  onDeny: (id: string) => Promise<void>;
}) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function act(action: (id: string) => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action(hold.id);
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="automodItem">
      <div className="automodItemHead">
        <strong>{hold.displayName}</strong>
        {hold.category ? (
          <span className="automodTag">{hold.category}{hold.level != null ? ` · L${hold.level}` : ''}</span>
        ) : null}
      </div>
      <p className="automodMessage">{hold.message}</p>
      {error ? <p className="automodError">{error}</p> : null}
      <div className="automodItemActions">
        <button className="accent" disabled={busy} onClick={() => void act(onAllow)}>Allow</button>
        <button className="dangerButton" disabled={busy} onClick={() => void act(onDeny)}>Deny</button>
      </div>
    </article>
  );
}

export function AutomodPanel({
  queue,
  showHistory = true,
  subscriptionInactive = false,
}: {
  queue: AutomodQueueController;
  showHistory?: boolean;
  subscriptionInactive?: boolean;
}) {
  const { pending, recentlyResolved, error, allow, deny } = queue;

  return (
    <div className="automodPanel">
      {subscriptionInactive ? (
        <p className="automodNotice">
          AutoMod isn’t connected — reconnect Twitch in Settings to grant
          <code> moderator:manage:automod</code> and start receiving held messages.
        </p>
      ) : null}
      {error ? (
        <p className="automodError">{error}</p>
      ) : pending.length === 0 ? (
        <div className="panel-empty">No messages currently held.</div>
      ) : (
        pending.map(hold => <AutomodItem key={hold.id} hold={hold} onAllow={allow} onDeny={deny} />)
      )}
      {showHistory && recentlyResolved.length > 0 ? (
        <div className="automodHistory">
          <p className="automodHistoryLabel">Recently resolved</p>
          {recentlyResolved.map(hold => (
            <div className="automodHistoryItem" key={hold.id}>
              <span>{hold.displayName}</span>
              <em>{hold.resolution}{hold.resolvedBy ? ` · ${hold.resolvedBy}` : ''}</em>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function AutomodQuickActions() {
  const queue = useAutomodQueue();
  return <AutomodPanel queue={queue} showHistory={false} />;
}
