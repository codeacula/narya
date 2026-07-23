import React from 'react';
import type { SessionShoutout } from '../../../shared/api';
import { kindChip, kindTone } from '../../eventKinds';

export function ShoutoutsPanel({
  shoutouts,
  streamActive,
  onOpenViewer,
}: {
  shoutouts: SessionShoutout[];
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
    return <div className="panel-empty">No stream session is active. Shoutouts collect once you go live.</div>;
  }
  if (shoutouts.length === 0) {
    return <div className="panel-empty">Nobody to shout out yet. Follows, subs, cheers, and raids collect here.</div>;
  }

  return (
    <div className="shout-feed">
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
