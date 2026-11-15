import React from 'react';
import type { MediaMuteState } from '../shared/api';
import { getMediaMute, setMediaMute } from './services/dashboard';
import { useLiveValueState, type LiveValueStatus } from './liveValue';
import { errorMessage } from './errors';

const UNMUTED: MediaMuteState = { muted: false };

/**
 * Shared state for the master media mute so the dashboard and the tablet stay in
 * sync: both seed from GET on mount, flip via PUT, and track `media:mute` so a
 * toggle on one surface lights the button on the other without a refresh.
 *
 * `status` says whether `muted` is known. Until it is `loaded`, `muted` is only the
 * fallback, so a surface must not show it as the switch's position: a failed load used
 * to draw "unmuted" while commands were in fact silenced. `error` is the last failed
 * toggle, cleared by the next attempt.
 */
export function useMediaMute(): {
  muted: boolean;
  status: LiveValueStatus;
  /** A refetch since the value was known failed; `muted` is only last-known. */
  stale: boolean;
  retry: () => void;
  busy: boolean;
  error: string | null;
  toggle: (next: boolean) => void;
} {
  const { value: state, setValue: setState, status, stale, retry } = useLiveValueState<MediaMuteState>(getMediaMute, 'media:mute', UNMUTED);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const toggle = React.useCallback((next: boolean) => {
    setBusy(true);
    setError(null);
    setMediaMute(next)
      .then(setState)
      .catch((caught: unknown) => setError(errorMessage(caught, next ? 'Could not mute commands' : 'Could not unmute commands')))
      .finally(() => setBusy(false));
  }, [setState]);

  return { muted: state.muted, status, stale, retry, busy, error, toggle };
}
