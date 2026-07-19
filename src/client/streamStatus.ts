import type { StreamStatus } from '../shared/api';
import { useLiveValue } from './liveValue';
import { getStreamStatus } from './services/dashboard';

// REST seed + live `status:updated` updates. Used by the overlay widget.
// The status line is edited from the Stream Info modal, not a dashboard strip.
export function useStreamStatus() {
  const [status] = useLiveValue<StreamStatus | null>(getStreamStatus, 'status:updated', null);

  return status;
}
