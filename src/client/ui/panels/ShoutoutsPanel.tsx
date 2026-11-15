import React from 'react';
import type { SessionShoutout } from '../../../shared/api';
import { kindChip, kindTone } from '../../eventKinds';
import { EmptyState } from '../emptyState';
import { loadPhase, type RefreshHealth } from '../../refreshHealth';
import { StaleNotice } from '../staleNotice';

export function ShoutoutsPanel({
  shoutouts,
  health,
  onRetry,
  streamActive,
  onOpenViewer,
}: {
  shoutouts: SessionShoutout[];
  /** How the roster's refetches stand (useSessionShoutouts). */
  health?: RefreshHealth;
  onRetry?: () => void;
  streamActive: boolean;
  onOpenViewer: (login: string) => void;
}) {
  const [copied, setCopied] = React.useState(false);

  const copyNames = React.useCallback(() => {
    const names = shoutouts.map(s => s.actor).join(' ');
    void navigator.clipboard.writeText(names).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch((error: unknown) => {
      console.error('Failed to copy shoutout names:', error);
    });
  }, [shoutouts]);

  if (!streamActive) {
    return <EmptyState title="Not streaming">Shoutouts collect once you go live.</EmptyState>;
  }
  const phase = health ? loadPhase(health) : 'fresh';
  if (shoutouts.length === 0 && phase === 'failed') {
    return (
      <EmptyState
        title="Shoutouts unavailable"
        action={onRetry ? <button className="modbtn" type="button" onClick={onRetry}>Retry</button> : undefined}
      >
        Narya could not load this stream's shoutouts.
      </EmptyState>
    );
  }
  if (shoutouts.length === 0 && phase === 'loading') {
    return <EmptyState title="Loading shoutouts…" />;
  }
  const stale = health ? <div className="feed-stale"><StaleNotice health={health} onRetry={onRetry} /></div> : null;
  if (shoutouts.length === 0) {
    return (
      <>
        {stale}
        <EmptyState title="Nobody to shout out yet">Follows, subs, cheers, and raids collect here.</EmptyState>
      </>
    );
  }

  return (
    <div className="shout-feed">
      {stale}
      <div className="att-toolbar">
        <span className="att-hint">{shoutouts.length} to thank this stream</span>
        <button className="att-dismiss" type="button" onClick={copyNames}>
          {copied ? 'Copied' : 'Copy names'}
        </button>
      </div>
      <div className="shout-list">
        {shoutouts.map(s => (
          <button
            key={s.login ?? s.actor.toLowerCase()}
            type="button"
            className="shout-row"
            // `actor` is a display name, which for a localized name doesn't
            // lowercase to the login — use the login Twitch gave us.
            onClick={() => onOpenViewer(s.login ?? s.actor.toLowerCase())}
            title={`Open ${s.actor}`}
          >
            <span className="shout-actor">{s.actor}</span>
            <span className="shout-kinds">
              {s.kinds.map(kind => (
                <span key={kind} className={'shout-chip tone-' + kindTone(kind)}>
                  {kindChip(kind)}
                </span>
              ))}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
