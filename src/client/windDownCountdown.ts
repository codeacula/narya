/**
 * Relative rather than absolute on purpose: "~25 min left" reads better to a viewer
 * than a wall-clock time, and it does not leak the streamer's timezone.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export function formatWindDownCountdown(msRemaining: number): string {
  if (msRemaining <= 0) return 'ending soon';

  if (msRemaining < MINUTE_MS) {
    return `~${Math.ceil(msRemaining / 1000)} sec left`;
  }

  if (msRemaining < HOUR_MS) {
    // Ceiling, so a countdown never reads a minute shorter than it is.
    return `~${Math.ceil(msRemaining / MINUTE_MS)} min left`;
  }

  const hours = Math.floor(msRemaining / HOUR_MS);
  const minutes = Math.floor((msRemaining % HOUR_MS) / MINUTE_MS);
  return `~${hours}h ${minutes}m left`;
}
