import React from 'react';
import type { LatestEvents, StreamEvent } from '../shared/api';
import { useSocket, useSocketReconnect } from './realtime';
import { getLatestEvents } from './services/dashboard';

/** A raid lands dozens of follows at once; coalesce them into one refetch. */
const LATEST_EVENTS_DEBOUNCE_MS = 1_500;

const BAR_EVENT_KINDS: ReadonlySet<string> = new Set(['follow', 'sub', 'gift', 'cheer', 'raid']);

const EMPTY: LatestEvents = { follow: null, sub: null, cheer: null, raid: null };

/**
 * The top bar's data: REST seed, then a debounced refetch whenever a stream event of a
 * shown kind arrives. Refetching rather than patching from the event keeps one place
 * deciding what "latest" means (the server), and the `stream:event` payload carries no
 * amount. Also refetches on socket reconnect so a gap in the socket cannot leave a
 * stale name on stream.
 */
export function useLatestEvents(): LatestEvents {
  const [latest, setLatest] = React.useState<LatestEvents>(EMPTY);
  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = React.useCallback(() => {
    void getLatestEvents().then(setLatest).catch((error: unknown) => {
      console.error('Failed to load latest events:', error);
    });
  }, []);

  React.useEffect(() => {
    refresh();
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [refresh]);

  useSocketReconnect(refresh);

  // Sent after a flush/unflush: "latest" changed with no stream event to prompt a
  // refetch, and the payload is the server's answer, so apply it directly.
  useSocket<LatestEvents>('overlay:latest-events', setLatest);

  useSocket<StreamEvent>('stream:event', React.useCallback((event) => {
    if (!BAR_EVENT_KINDS.has(event.kind)) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(refresh, LATEST_EVENTS_DEBOUNCE_MS);
  }, [refresh]));

  return latest;
}
