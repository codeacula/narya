import React from 'react';
import {
  INITIAL_REFRESH_HEALTH,
  isStale,
  recordRefresh,
  staleNoticeText,
  type RefreshHealth,
} from '../refreshHealth';

/**
 * Track a background refresh's outcome: call `succeeded()` / `failed()` from the
 * refresh, and render `<StaleNotice health={health} />` near the list it keeps fresh.
 */
export function useRefreshHealth() {
  const [health, setHealth] = React.useState<RefreshHealth>(INITIAL_REFRESH_HEALTH);
  const succeeded = React.useCallback(() => setHealth(current => recordRefresh(current, true, Date.now())), []);
  const failed = React.useCallback(() => setHealth(current => recordRefresh(current, false, Date.now())), []);
  return { health, succeeded, failed };
}

const AGE_TICK_MS = 30_000;

/**
 * The quiet "couldn't refresh · last updated 2m ago" line under a list whose background
 * refresh is failing. It is deliberately not a toast: a poll fails every 30 seconds
 * while the backend is down, and the operator needs to know the list is old, not to be
 * told again each time. Renders nothing while the list is fresh. `onRetry`, when given,
 * adds a retry button for lists whose next automatic refresh may be a long way off.
 */
export function StaleNotice({ health, onRetry }: { health: RefreshHealth; onRetry?: () => void }) {
  const stale = isStale(health);
  const [, setTick] = React.useState(0);
  // Re-render while stale so "last updated" keeps counting rather than freezing at
  // the age it had when the refresh first failed.
  React.useEffect(() => {
    if (!stale) return;
    const timer = setInterval(() => setTick(tick => tick + 1), AGE_TICK_MS);
    return () => clearInterval(timer);
  }, [stale]);

  const text = staleNoticeText(health);
  if (!text) return null;
  return (
    <div className="stale-notice" role="status">
      <span>{text}</span>
      {onRetry ? <button className="stale-notice-retry" type="button" onClick={onRetry}>Retry</button> : null}
    </div>
  );
}
