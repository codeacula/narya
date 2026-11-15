import React from 'react';
import { Icon } from '../icons';
import { EmptyState } from '../emptyState';
import { formatAgo } from '../../../shared/time';
import { kindEyebrow, kindTone } from '../../eventKinds';
import { DEFAULT_ATTENTION_TAG, type AttentionItem, type AttentionSettings } from '../../attention';
import { EVT_ICON } from './eventPresentation';
import { NOTHING_BELOW, overflowBelow, overflowLabel, sameOverflow, type OverflowBelow } from '../../attentionOverflow';

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Tracks what is below the fold of a scrolling list: re-measured on scroll, on resize
 * (the panel is resizable and can pop out), and whenever the items or their
 * highlights change. Rows are the list's direct children, in order.
 */
function useOverflowBelow(
  listRef: React.RefObject<HTMLDivElement | null>,
  unackedFlags: readonly boolean[],
): [OverflowBelow, () => void] {
  const [overflow, setOverflow] = React.useState<OverflowBelow>(NOTHING_BELOW);
  const frameRef = React.useRef(0);
  const flagsRef = React.useRef(unackedFlags);
  flagsRef.current = unackedFlags;

  const measure = React.useCallback(() => {
    const list = listRef.current;
    if (!list) {
      setOverflow(NOTHING_BELOW);
      return;
    }
    const rows = Array.from(list.children as HTMLCollectionOf<HTMLElement>).map((row, index) => ({
      top: row.offsetTop,
      bottom: row.offsetTop + row.offsetHeight,
      unacked: flagsRef.current[index] ?? false,
    }));
    const next = overflowBelow(rows, { scrollTop: list.scrollTop, clientHeight: list.clientHeight });
    setOverflow(previous => (sameOverflow(previous, next) ? previous : next));
  }, [listRef]);

  // Scroll events arrive faster than frames; measure once per frame.
  const schedule = React.useCallback(() => {
    if (frameRef.current) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0;
      measure();
    });
  }, [measure]);

  React.useLayoutEffect(measure, [measure, unackedFlags]);

  // The list box (panel resize, pop-out) and each row (a late web font, a wrapped
  // detail line). Re-attached when the rows change, which also covers the list
  // mounting for the first time after the feed was empty.
  React.useEffect(() => {
    const list = listRef.current;
    if (!list || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(schedule);
    observer.observe(list);
    for (const row of Array.from(list.children)) observer.observe(row);
    return () => observer.disconnect();
  }, [listRef, schedule, unackedFlags]);

  React.useEffect(() => () => cancelAnimationFrame(frameRef.current), []);

  return [overflow, schedule];
}

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
  const listRef = React.useRef<HTMLDivElement>(null);
  // A fresh array only when a highlight actually changes, so the measuring effect
  // does not re-run on every parent render.
  const unackedFlags = React.useMemo(() => items.map(item => !acked.has(item.id)), [items, acked]);
  const [below, onListScroll] = useOverflowBelow(listRef, unackedFlags);

  const showBelow = React.useCallback(() => {
    const list = listRef.current;
    if (!list || below.scrollTarget === null) return;
    list.scrollTo({ top: below.scrollTarget, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    // Reaching the end unmounts this footer while it has focus, which drops focus to
    // <body>. Land it on the first row just revealed instead — every row is already
    // a button, so this adds no tab stop. preventScroll leaves the scroll above in
    // charge, smooth or not.
    const row = below.firstIndex === null ? null : list.children[below.firstIndex];
    if (row instanceof HTMLElement) row.focus({ preventScroll: true });
  }, [below.scrollTarget, below.firstIndex]);

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
        <EmptyState title="Nothing to thank yet">Follows, subs, cheers, raids, and tagged chat land here.</EmptyState>
      ) : (
        <div className="att-list-wrap">
          <div className="att-list" ref={listRef} onScroll={onListScroll}>
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
                  {/* Read like the overlay's alert cards: mono eyebrow, italic name, detail. */}
                  <span className="evt-body">
                    <span className="att-eyebrow">{item.kind === 'chat' ? 'tagged chat' : kindEyebrow(item.kind)}</span>
                    <span className="att-actor">{item.actor}</span>
                    <span className="evt-detail">{item.detail}</span>
                  </span>
                  <span className="evt-ago">{item.at ? formatAgo(item.at) : ''}</span>
                </button>
              );
            })}
          </div>
          {/* The list is clipped at the panel edge; without this the last row is simply
              cut, with nothing to say whether it is the last. A footer in flow rather
              than a chip over the list, so the cue never covers a row it is pointing at;
              its ::before is the fade over the clipped edge. */}
          {below.count > 0 && (
            <button type="button" className="att-more" onClick={showBelow}>
              <Icon name="chevron-down" size={11} />
              {overflowLabel(below)}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
