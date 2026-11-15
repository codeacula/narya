import type { ObsStatus } from '../shared/api';

// The words for a connected or offline OBS live with every other service's in
// connectionWords.ts; re-exported here for the callers that already import them.
export { OBS_OFFLINE, obsConnectionLabel } from './connectionWords';

/**
 * What the tablet's OBS panel says when something is wrong, in the operator's words.
 *
 * `message` is the sentence to show; `detail` is the raw error behind it, kept for a
 * secondary line and a tooltip but never shown as the headline. OBS being down is a
 * state Narya already handles (it reconnects on a timer, see `scheduleReconnect` in
 * server/obs.ts), so it reads as a notice rather than an alarm — `tone` says which.
 */
export type ObsNotice = {
  message: string;
  detail: string | null;
  tone: 'offline' | 'error';
};

export function obsNotice({
  obsStatus,
  loaded,
  statusError,
  commandError,
}: {
  obsStatus: Pick<ObsStatus, 'connected' | 'lastError'>;
  /** False until the first status has arrived, so the page does not flash "offline" on load. */
  loaded: boolean;
  /** Narya itself did not answer the status request. */
  statusError: string | null;
  /** The operator's last button press failed. Already worded by the caller. */
  commandError: string | null;
}): ObsNotice | null {
  // The operator's own action outranks a standing state: it is what they are looking at.
  if (commandError) return { message: commandError, detail: null, tone: 'error' };
  if (statusError) {
    return { message: 'Could not load OBS status from Narya.', detail: statusError, tone: 'error' };
  }
  if (!loaded) return null;
  if (!obsStatus.connected) {
    return {
      message: 'OBS is offline. Narya keeps retrying, and the scene buttons return when it connects.',
      detail: obsStatus.lastError,
      tone: 'offline',
    };
  }
  // Connected, but a request since then failed (stats polling sets this).
  if (obsStatus.lastError) {
    return { message: 'OBS did not answer the last request.', detail: obsStatus.lastError, tone: 'error' };
  }
  return null;
}
