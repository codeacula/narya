import React from 'react';
import type { WindDownPublicState } from '../shared/api';
import { useSocket } from './realtime';
import { getWindDown, setWindDown } from './services/dashboard';

/**
 * REST seed plus live `winddown:updated`. Used by both the operator toggle and the
 * overlay browser source — the GET is on the overlay token's read allowlist so a
 * source can seed itself, and the PUT is operator-only.
 */
function useWindDownState() {
  const [state, setState] = React.useState<WindDownPublicState | null>(null);

  React.useEffect(() => {
    getWindDown()
      .then(setState)
      .catch(() => setState(null));
  }, []);

  useSocket<WindDownPublicState>(
    'winddown:updated',
    React.useCallback((next: WindDownPublicState) => setState(next), []),
  );

  return [state, setState] as const;
}

/** Read-only, for the browser source. */
export function useWindDownOverlay(): WindDownPublicState | null {
  const [state] = useWindDownState();
  return state;
}

/** Read/write, for the dashboard control. */
export function useWindDown() {
  const [state, setState] = useWindDownState();
  const [busy, setBusy] = React.useState(false);

  const toggle = React.useCallback((next: boolean) => {
    setBusy(true);
    setWindDown(next)
      .then(setState)
      .catch(() => undefined)
      .finally(() => setBusy(false));
  }, [setState]);

  return { state, busy, toggle };
}
