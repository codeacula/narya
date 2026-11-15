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
 * Whether a live value is known. `loading` until the first fetch settles; `loaded` once
 * a fetch or any write (a socket event, the caller's own setter) has supplied a value;
 * `failed` when the first fetch failed and nothing has been written since.
 *
 * A later failure (a reconnect refetch) never moves a known value back to `failed`:
 * the value on screen came from the server and is only possibly stale, which the
 * reconnect will fix. A retry moves `failed` back to `loading`.
 */
export type LiveValueStatus = 'loading' | 'loaded' | 'failed';

export type LiveValueEvent = 'retry' | 'fetched' | 'written' | 'fetch-failed';

export function nextLiveValueStatus(current: LiveValueStatus, event: LiveValueEvent): LiveValueStatus {
  switch (event) {
    case 'fetched':
    case 'written':
      return 'loaded';
    case 'retry':
      return current === 'failed' ? 'loading' : current;
    case 'fetch-failed':
      return current === 'loaded' ? 'loaded' : 'failed';
  }
}

/**
 * Seed a value from REST on mount, then let a WebSocket event replace it.
 *
 * A failed initial fetch leaves `fallback` in place: these are display values
 * whose absence is itself meaningful (no track, off-stream, unmuted), so the
 * hook has no error state for a caller to render. A control that WRITES the value
 * (the media mute) must not present that fallback as the truth: it uses
 * `useLiveValueState`, which also says whether the value is known.
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
  const { value, setValue } = useLiveValueState(fetcher, eventName, fallback);
  return [value, setValue];
}

/** `useLiveValue`, plus whether the value is known yet and a way to ask again. */
export function useLiveValueState<T>(fetcher: () => Promise<T>, eventName: string, fallback: T): {
  value: T;
  setValue: React.Dispatch<React.SetStateAction<T>>;
  status: LiveValueStatus;
  retry: () => void;
} {
  const [value, setValueState] = React.useState<T>(fallback);
  const [status, setStatus] = React.useState<LiveValueStatus>('loading');
  const fetchRef = React.useRef(fetcher);
  fetchRef.current = fetcher;
  const fallbackRef = React.useRef(fallback);
  fallbackRef.current = fallback;
  const guardRef = React.useRef(createWriteGuard());
  const mountedRef = React.useRef(true);

  const setValue = React.useCallback<React.Dispatch<React.SetStateAction<T>>>((next) => {
    guardRef.current.bump();
    setValueState(next);
    setStatus(current => nextLiveValueStatus(current, 'written'));
  }, []);

  const refresh = React.useCallback((resetOnError: boolean) => {
    const isCurrent = guardRef.current.begin();
    fetchRef.current()
      .then((next) => {
        if (mountedRef.current && isCurrent()) {
          setValueState(next);
          setStatus(current => nextLiveValueStatus(current, 'fetched'));
        }
      })
      .catch(() => {
        if (!mountedRef.current || !isCurrent()) return;
        if (resetOnError) setValueState(fallbackRef.current);
        setStatus(current => nextLiveValueStatus(current, 'fetch-failed'));
      });
  }, []);

  React.useEffect(() => {
    mountedRef.current = true;
    refresh(true);
    return () => { mountedRef.current = false; };
  }, [refresh]);

  const retry = React.useCallback(() => {
    setStatus(current => nextLiveValueStatus(current, 'retry'));
    // Keeps the value on a second failure: a failed value is already the fallback.
    refresh(false);
  }, [refresh]);

  useSocketReconnect(React.useCallback(() => refresh(false), [refresh]));

  useSocket<T>(eventName, React.useCallback((next: T) => setValue(next), [setValue]));

  return { value, setValue, status, retry };
}
