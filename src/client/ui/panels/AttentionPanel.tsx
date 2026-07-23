import React from 'react';
import { Icon } from '../icons';
import { formatAgo } from '../../../shared/time';
import { kindTone } from '../../eventKinds';
import { DEFAULT_ATTENTION_TAG, type AttentionItem, type AttentionSettings } from '../../attention';
import { EVT_ICON } from './eventPresentation';

export function AttentionDismissAll({ disabled, onDismiss }: { disabled: boolean; onDismiss: () => void }) {
  return (
    <button
      className="att-dismiss"
      type="button"
      disabled={disabled}
      onClick={onDismiss}
      title="Clear every highlight"
    >
      Dismiss all
    </button>
  );
}

export function AttentionPanel({
  items,
  acked,
  settings,
  onAck,
  onSettingsChange,
}: {
  items: AttentionItem[];
  acked: Set<string>;
  settings: AttentionSettings;
  onAck: (id: string) => void;
  onSettingsChange: (patch: Partial<AttentionSettings>) => void;
}) {
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const settingsRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!settingsOpen) return;
    const handler = (e: MouseEvent) => {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) setSettingsOpen(false);
    };
    const keyHandler = (e: KeyboardEvent) => { if (e.key === 'Escape') setSettingsOpen(false); };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', keyHandler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', keyHandler);
    };
  }, [settingsOpen]);

  return (
    <div className="att-feed">
      <div className="att-toolbar">
        <span className="att-hint">
          {items.length === 0 ? 'nothing waiting' : 'click an item to clear its highlight'}
        </span>
        <div className="evt-filter-anchor" ref={settingsRef}>
          <button
            className={'evt-filter-btn' + (settingsOpen ? ' open' : '')}
            onClick={() => setSettingsOpen(o => !o)}
            title="Attention feed settings"
            type="button"
          >
            Settings
          </button>
          {settingsOpen && (
            <div className="evt-filter-menu att-settings">
              <label className="att-settings-field">
                <span>Route chat from viewers tagged</span>
                <input
                  type="text"
                  value={settings.tag}
                  placeholder={DEFAULT_ATTENTION_TAG}
                  onChange={e => onSettingsChange({ tag: e.target.value })}
                />
              </label>
              <label className="evt-filter-item">
                <input
                  type="checkbox"
                  checked={settings.soundEnabled}
                  onChange={e => onSettingsChange({ soundEnabled: e.target.checked })}
                />
                Chime on new items
              </label>
              <label className="evt-filter-item">
                <input
                  type="checkbox"
                  checked={settings.mentionSoundEnabled}
                  onChange={e => onSettingsChange({ mentionSoundEnabled: e.target.checked })}
                />
                Sound when chat @mentions you
              </label>
            </div>
          )}
        </div>
      </div>
      {items.length === 0 ? (
        <div className="panel-empty">Follows, subs, cheers, raids, and tagged chat land here.</div>
      ) : (
        <div className="att-list">
          {items.map(item => {
            const unacked = !acked.has(item.id);
            const tone = kindTone(item.kind);
            return (
              <button
                key={item.id}
                type="button"
                className={`att-row tone-${tone}${unacked ? ' att-row--unacked' : ''}`}
                onClick={() => onAck(item.id)}
                title={unacked ? 'Click to clear the highlight' : 'Cleared'}
              >
                <span className="evt-icon">
                  <Icon name={EVT_ICON[item.kind] ?? 'star'} />
                </span>
                <span className="evt-body">
                  <span className="evt-actor">{item.actor}</span>
                  <span className="evt-detail">{item.detail}</span>
                </span>
                <span className="evt-ago">{item.at ? formatAgo(item.at) : ''}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
