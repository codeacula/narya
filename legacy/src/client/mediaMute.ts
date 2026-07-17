import React from 'react';
import type { MediaMuteState } from '../shared/api';
import { getMediaMute, setMediaMute } from './services/dashboard';
import { useSocket } from './realtime';

/**
 * Shared state for the master media mute so the dashboard and the tablet stay in
 * sync: both seed from GET on mount, flip via PUT, and track `media:mute` so a
 * toggle on one surface lights the button on the other without a refresh.
 */
export function useMediaMute() {
  const [muted, setMuted] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    getMediaMute()
      .then(state => setMuted(state.muted))
      .catch(() => setMuted(false));
  }, []);

  useSocket<MediaMuteState>(
    'media:mute',
    React.useCallback((next: MediaMuteState) => setMuted(next.muted), []),
  );

  const toggle = React.useCallback((next: boolean) => {
    setBusy(true);
    setMediaMute(next)
      .then(state => setMuted(state.muted))
      .catch(() => undefined)
      .finally(() => setBusy(false));
  }, []);

  return { muted, busy, toggle };
}
