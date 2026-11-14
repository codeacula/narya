import type { OverlayStreamSession } from '../shared/api';
import { useLiveValue } from './liveValue';
import { getOverlayStreamSession } from './services/dashboard';

const OFF_STREAM: OverlayStreamSession = { startedAt: null };

/** REST seed + live `overlay:stream-session` (broadcast when a session starts or ends). */
export function useStreamSessionStart(): string | null {
  const [session] = useLiveValue<OverlayStreamSession>(getOverlayStreamSession, 'overlay:stream-session', OFF_STREAM);
  return session.startedAt;
}
