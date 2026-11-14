import React from 'react';
import { useSocket, useSocketReconnect } from './realtime';

/**
 * Tracks writes so a slow fetch cannot overwrite something newer. `begin()` is called
 * when a fetch starts; the returned check is true only if no write happened since.
 */
export function createWriteGuard() {
  let version = 0;
  return {
    bump() { version += 1; },
    begin() {
      const startedAt = version;
      return () => version === startedAt;
    },
  };
}

/**
 * Seed a value from REST on mount, then let a WebSocket event replace it.
 *
 * A failed initial fetch leaves `fallback` in place: these are display values
 * whose absence is itself meaningful (no track, off-stream, unmuted), so the
 * hook has no error state for a caller to render.
 *
 * The shared socket reconnects without replaying what it missed, so the value is
 * refetched on every reconnect — otherwise a pinned card or ad banner cleared during
 * the gap would stay on stream. A failed refetch keeps the current value rather than
 * resetting it: stale is better than blank for something that was just correct.
 *
 * Every write (socket event or the returned setter) bumps a version, and a fetch only
 * applies if nothing was written since it started. Without that, a slow response
 * resolving after a newer socket event would put the older value back.
 */
export function useLiveValue<T>(fetcher: () => Promise<T>, eventName: string, fallback: T): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [value, setValueState] = React.useState<T>(fallback);
  const fetchRef = React.useRef(fetcher);
  fetchRef.current = fetcher;
  const fallbackRef = React.useRef(fallback);
  fallbackRef.current = fallback;
  const guardRef = React.useRef(createWriteGuard());
  const mountedRef = React.useRef(true);

  const setValue = React.useCallback<React.Dispatch<React.SetStateAction<T>>>((next) => {
    guardRef.current.bump();
    setValueState(next);
  }, []);

  const refresh = React.useCallback((resetOnError: boolean) => {
    const isCurrent = guardRef.current.begin();
    fetchRef.current()
      .then((next) => {
        if (mountedRef.current && isCurrent()) setValueState(next);
      })
      .catch(() => {
        if (resetOnError && mountedRef.current && isCurrent()) setValueState(fallbackRef.current);
      });
  }, []);

  React.useEffect(() => {
    mountedRef.current = true;
    refresh(true);
    return () => { mountedRef.current = false; };
  }, [refresh]);

  useSocketReconnect(React.useCallback(() => refresh(false), [refresh]));

  useSocket<T>(eventName, React.useCallback((next: T) => setValue(next), [setValue]));

  return [value, setValue];
}
