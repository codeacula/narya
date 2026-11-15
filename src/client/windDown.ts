import React from 'react';
import type { WindDownPublicState } from '../shared/api';
import { useSocket } from './realtime';
import { getWindDown, setWindDown } from './services/dashboard';
import { errorMessage } from './errors';
import type { LiveValueStatus } from './liveValue';

/**
 * REST seed plus live `winddown:updated`. Used by both the operator toggle and the
 * overlay browser source — the GET is on the overlay token's read allowlist so a
 * source can seed itself, and the PUT is operator-only.
 *
 * `status` is for the operator control: a failed GET leaves `state` null, which the
 * overlay rightly reads as "nothing to show" but the switch must not draw as "off".
 */
function useWindDownState() {
  const [state, setStateValue] = React.useState<WindDownPublicState | null>(null);
  const [status, setStatus] = React.useState<LiveValueStatus>('loading');
  const [attempt, setAttempt] = React.useState(0);

  const setState = React.useCallback((next: WindDownPublicState) => {
    setStateValue(next);
    setStatus('loaded');
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    getWindDown()
      .then(next => { if (!cancelled) setState(next); })
      .catch(() => {
        if (cancelled) return;
        setStatus(current => (current === 'loaded' ? current : 'failed'));
      });
    return () => { cancelled = true; };
  }, [attempt, setState]);

  useSocket<WindDownPublicState>('winddown:updated', setState);

  const retry = React.useCallback(() => {
    setStatus(current => (current === 'failed' ? 'loading' : current));
    setAttempt(n => n + 1);
  }, []);

  return { state, setState, status, retry };
}

/** Read-only, for the browser source. */
export function useWindDownOverlay(): WindDownPublicState | null {
  return useWindDownState().state;
}

/** Read/write, for the dashboard control. `error` is the last failed toggle. */
export function useWindDown() {
  const { state, setState, status, retry } = useWindDownState();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const toggle = React.useCallback((next: boolean) => {
    setBusy(true);
    setError(null);
    setWindDown(next)
      .then(setState)
      .catch((caught: unknown) => setError(errorMessage(caught, next ? 'Could not start the wind-down' : 'Could not stop the wind-down')))
      .finally(() => setBusy(false));
  }, [setState]);

  return { state, status, retry, busy, error, toggle };
}
