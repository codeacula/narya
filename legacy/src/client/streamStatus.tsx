import React from 'react';
import type { StreamStatus } from '../shared/api';
import { useSocket } from './realtime';
import { getStreamStatus } from './services/dashboard';

// REST seed + live `status:updated` updates. Used by the overlay widget.
// The status line is edited from the Stream Info modal, not a dashboard strip.
export function useStreamStatus() {
  const [status, setStatus] = React.useState<StreamStatus | null>(null);

  React.useEffect(() => {
    getStreamStatus()
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  useSocket<StreamStatus>(
    'status:updated',
    React.useCallback((next) => setStatus(next), []),
  );

  return status;
}
