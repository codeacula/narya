import React from 'react';
import type { MediaMuteState } from '../shared/api';
import { getMediaMute, setMediaMute } from './services/dashboard';
import { useLiveValue } from './liveValue';

const UNMUTED: MediaMuteState = { muted: false };

/**
 * Shared state for the master media mute so the dashboard and the tablet stay in
 * sync: both seed from GET on mount, flip via PUT, and track `media:mute` so a
 * toggle on one surface lights the button on the other without a refresh.
 */
export function useMediaMute() {
  const [state, setState] = useLiveValue<MediaMuteState>(getMediaMute, 'media:mute', UNMUTED);
  const [busy, setBusy] = React.useState(false);

  const toggle = React.useCallback((next: boolean) => {
    setBusy(true);
    setMediaMute(next)
      .then(setState)
      .catch(() => undefined)
      .finally(() => setBusy(false));
  }, [setState]);

  return { muted: state.muted, busy, toggle };
}
