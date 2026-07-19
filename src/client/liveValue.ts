import React from 'react';
import { useSocket } from './realtime';

/**
 * Seed a value from REST on mount, then let a WebSocket event replace it.
 *
 * A failed initial fetch leaves `fallback` in place: these are display values
 * whose absence is itself meaningful (no track, off-stream, unmuted), so the
 * hook has no error state for a caller to render.
 */
export function useLiveValue<T>(fetcher: () => Promise<T>, eventName: string, fallback: T): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [value, setValue] = React.useState<T>(fallback);
  const fetchRef = React.useRef(fetcher);
  fetchRef.current = fetcher;
  const fallbackRef = React.useRef(fallback);
  fallbackRef.current = fallback;

  React.useEffect(() => {
    fetchRef.current()
      .then(setValue)
      .catch(() => setValue(fallbackRef.current));
  }, []);

  useSocket<T>(eventName, React.useCallback((next: T) => setValue(next), []));

  return [value, setValue];
}
