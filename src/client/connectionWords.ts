import type { DashboardStatus } from '../shared/api';

/**
 * The one vocabulary for "is Narya connected to this service?", used by the stat bar,
 * the tablet's OBS chip, the service toasts and the Display panel's Live Data list.
 *
 * Two words: connected, and offline. Not "unavailable" (which reads as broken for
 * good), not "disconnected" (which reads as something the operator did), and not
 * "open"/"closed" (socket jargon). A service Narya is still dialling is "connecting";
 * a state the dashboard has not heard yet is "unknown". Lower case, except names.
 */
export type ConnectionWord = 'connected' | 'connecting' | 'offline' | 'unknown';

export function connectionWord(connected: boolean): 'connected' | 'offline' {
  return connected ? 'connected' : 'offline';
}

/** Twitch chat's socket reports more than up/down; fold it into the same words. */
export function chatConnectionWord(state: DashboardStatus['chatConnection']): ConnectionWord {
  switch (state) {
    case 'OPEN':
      return 'connected';
    case 'CONNECTING':
      return 'connecting';
    case 'CLOSING':
    case 'CLOSED':
      return 'offline';
    default:
      return 'unknown';
  }
}

/** A toast or gauge headline: "Redis offline", "Twitch EventSub connected". */
export function serviceStateTitle(service: string, connected: boolean): string {
  return `${service} ${connectionWord(connected)}`;
}

/** "Narya is not connected to OBS", wherever it is said. */
export const OBS_OFFLINE = serviceStateTitle('OBS', false);

/**
 * The tablet's status chip, which already sits under an "OBS" eyebrow. `null` is a
 * state the tablet has not heard yet (its status GET failed, or is still out): the
 * placeholder status says "disconnected", and the chip must not repeat that as fact.
 */
export function obsConnectionLabel(connected: boolean | null): string {
  if (connected === null) return 'Unknown';
  return connected ? 'Connected' : 'Offline';
}

/** The chip's dot: green, red, or the quiet grey of a state nobody has reported. */
export function obsConnectionDot(connected: boolean | null): 'connected' | 'disconnected' | 'idle' {
  if (connected === null) return 'idle';
  return connected ? 'connected' : 'disconnected';
}
