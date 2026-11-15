import React from 'react';
import { errorMessage } from './errors';

/**
 * A list fetched once on mount, with the three facts `[]` alone cannot carry: whether
 * it is still loading, whether the load failed, and a way to try again. Feed it to
 * `listFace` (pages/settings/listState.ts) so a failed load is never drawn as "none".
 *
 * `loading` stays true through a retry; `error` is kept until a load succeeds, so the
 * "unavailable" face (and the Retry the operator just pressed) stays mounted while the
 * retry is in flight.
 */
export function useLoadOnce<T>(fetcher: () => Promise<T[]>, errorFallback: string): {
  items: T[];
  loading: boolean;
  error: string | null;
  retry: () => void;
} {
  const [items, setItems] = React.useState<T[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [attempt, setAttempt] = React.useState(0);
  const fetchRef = React.useRef(fetcher);
  fetchRef.current = fetcher;

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchRef.current()
      .then(next => {
        if (cancelled) return;
        setItems(next);
        setError(null);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(errorMessage(caught, errorFallback));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [attempt, errorFallback]);

  const retry = React.useCallback(() => setAttempt(n => n + 1), []);
  return { items, loading, error, retry };
}
