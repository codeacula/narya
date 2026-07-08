import React from 'react';
import type { AutomodHold } from '../shared/api';
import { useSocket } from './realtime';
import { allowAutomodHold, denyAutomodHold, getAutomodQueue } from './services/dashboard';

export function useAutomodQueue() {
  const [pending, setPending] = React.useState<AutomodHold[]>([]);
  const [recentlyResolved, setRecentlyResolved] = React.useState<AutomodHold[]>([]);

  React.useEffect(() => {
    getAutomodQueue()
      .then(queue => {
        setPending(queue.pending);
        setRecentlyResolved(queue.recentlyResolved);
      })
      .catch((error: unknown) => {
        console.error('Failed to load AutoMod queue:', error);
      });
  }, []);

  useSocket<AutomodHold>(
    'automod:held',
    React.useCallback((hold) => {
      setPending(current => (current.some(h => h.id === hold.id) ? current : [...current, hold]));
    }, []),
  );

  useSocket<AutomodHold>(
    'automod:resolved',
    React.useCallback((hold) => {
      setPending(current => current.filter(h => h.id !== hold.id));
      setRecentlyResolved(current => [hold, ...current.filter(h => h.id !== hold.id)].slice(0, 20));
    }, []),
  );

  const allow = React.useCallback((id: string) => allowAutomodHold(id), []);
  const deny = React.useCallback((id: string) => denyAutomodHold(id), []);

  return { pending, recentlyResolved, allow, deny };
}

function AutomodItem({
  hold,
  onAllow,
  onDeny,
}: {
  hold: AutomodHold;
  onAllow: (id: string) => Promise<AutomodHold>;
  onDeny: (id: string) => Promise<AutomodHold>;
}) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function act(action: (id: string) => Promise<AutomodHold>) {
    setBusy(true);
    setError(null);
    try {
      await action(hold.id);
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : 'Action failed');
      setBusy(false);
    }
  }

  return (
    <article className="automodItem">
      <div className="automodItemHead">
        <strong>{hold.displayName}</strong>
        {hold.category ? <span className="automodTag">{hold.category} · L{hold.level}</span> : null}
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

export function AutomodPanel() {
  const { pending, recentlyResolved, allow, deny } = useAutomodQueue();

  return (
    <div className="automodPanel">
      {pending.length === 0 ? (
        <p className="muted">No messages currently held.</p>
      ) : (
        pending.map(hold => <AutomodItem key={hold.id} hold={hold} onAllow={allow} onDeny={deny} />)
      )}
      {recentlyResolved.length > 0 ? (
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
  const { pending, allow, deny } = useAutomodQueue();

  if (pending.length === 0) return <p className="muted">No messages held.</p>;

  return (
    <div className="automodPanel">
      {pending.map(hold => <AutomodItem key={hold.id} hold={hold} onAllow={allow} onDeny={deny} />)}
    </div>
  );
}
