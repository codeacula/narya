import React from 'react';
import { Icon } from '../icons';
import { formatAgo } from '../../../shared/time';
import { belongsToCurrentSession, sessionBoundaryIndex, type PanelCtx } from './context';
import {
  EVT_ICON,
  EVT_KIND_LABEL,
  EVT_TONE_OVERRIDE,
  loadHiddenKinds,
  saveHiddenKinds,
} from './eventPresentation';

export function EventFeed({ ctx }: { ctx: PanelCtx }) {
  const [hiddenKinds, setHiddenKinds] = React.useState<Set<string>>(() => loadHiddenKinds());
  const [evtSearch, setEvtSearch] = React.useState('');
  const [filterOpen, setFilterOpen] = React.useState(false);
  const filterRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!filterOpen) return;
    const handler = (e: MouseEvent) => {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) {
        setFilterOpen(false);
      }
    };
    const keyHandler = (e: KeyboardEvent) => { if (e.key === 'Escape') setFilterOpen(false); };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', keyHandler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', keyHandler);
    };
  }, [filterOpen]);

  const toggleKind = React.useCallback((kind: string) => {
    setHiddenKinds(prev => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      saveHiddenKinds(next);
      return next;
    });
  }, []);

  const knownKinds = React.useMemo(
    () => [...new Set(ctx.events.map(e => e.kind))],
    [ctx.events],
  );

  const hiddenCount = React.useMemo(
    () => knownKinds.filter(k => hiddenKinds.has(k)).length,
    [knownKinds, hiddenKinds],
  );

  const visibleEvents = React.useMemo(() => {
    const q = evtSearch.trim().toLowerCase();
    return ctx.events.filter(e => {
      if (hiddenKinds.has(e.kind)) return false;
      if (!q) return true;
      return (
        e.actor.toLowerCase().includes(q) ||
        (e.detail ?? '').toLowerCase().includes(q) ||
        (EVT_KIND_LABEL[e.kind] ?? e.kind).toLowerCase().includes(q)
      );
    });
  }, [ctx.events, hiddenKinds, evtSearch]);

  // Events are newest-first, so the boundary is the first row from a past stream.
  const pastSessionStart = React.useMemo(
    () => sessionBoundaryIndex(visibleEvents, ctx.currentSessionId, { side: 'past', markListStart: true }),
    [visibleEvents, ctx.currentSessionId],
  );

  return (
    <div className="evt-feed">
      <div className="evt-toolbar">
        <input
          className="evt-search"
          placeholder="search..."
          value={evtSearch}
          onChange={e => setEvtSearch(e.target.value)}
        />
        {knownKinds.length > 0 && (
          <div className="evt-filter-anchor" ref={filterRef}>
            <button
              className={'evt-filter-btn' + (filterOpen ? ' open' : '')}
              onClick={() => setFilterOpen(o => !o)}
              title="Toggle event filters"
            >
              Filters{hiddenCount > 0 ? ` (${hiddenCount})` : ''}
            </button>
            {filterOpen && (
              <div className="evt-filter-menu">
                {knownKinds.map(kind => (
                  <label key={kind} className="evt-filter-item">
                    <input
                      type="checkbox"
                      checked={!hiddenKinds.has(kind)}
                      onChange={() => toggleKind(kind)}
                    />
                    {EVT_KIND_LABEL[kind] ?? kind}
                  </label>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="evt-list">
        {visibleEvents.map((e, index) => {
          const tone = EVT_TONE_OVERRIDE[e.kind] ?? e.tone;
          const fromThisStream = belongsToCurrentSession(e.sessionId, ctx.currentSessionId);
          return (
            <React.Fragment key={e.id}>
              {index === pastSessionStart && <div className="evt-divider">earlier streams</div>}
              <div className={'evt tone-' + tone + (fromThisStream ? '' : ' evt--past')}>
                <div className="evt-icon">
                  <Icon name={EVT_ICON[e.kind] ?? 'star'} />
                </div>
                <div className="evt-body">
                  <div className="evt-actor">
                    {e.actor} <span className="verb">{e.kind === 'follow' ? 'followed' : ''}</span>
                  </div>
                  {e.kind !== 'follow' && <div className="evt-detail">{e.detail}</div>}
                </div>
                <div className="evt-ago">{e.receivedAt ? formatAgo(e.receivedAt) : e.ago}</div>
              </div>
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}
