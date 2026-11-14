const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;

const pad2 = (value: number) => String(value).padStart(2, '0');

/**
 * HH:MM:SS for how long the stream has been live. Always at least two hour digits (the
 * bar's layout is drawn against 01:24:07) and grows past 99 rather than wrapping.
 *
 * A negative elapsed time — the operator's clock running behind Twitch's start stamp —
 * clamps to zero: a stream that "started in the future" should read as just-started,
 * never as a minus sign on stream.
 */
export function formatUptime(elapsedMs: number): string {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return '00:00:00';
  const hours = Math.floor(elapsedMs / HOUR_MS);
  const minutes = Math.floor((elapsedMs % HOUR_MS) / MINUTE_MS);
  const seconds = Math.floor((elapsedMs % MINUTE_MS) / SECOND_MS);
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
}

/** Uptime from an RFC3339 start time, or null when there is no (parseable) start. */
export function uptimeSince(startedAt: string | null, nowMs: number): string | null {
  if (!startedAt) return null;
  const startMs = new Date(startedAt).getTime();
  if (!Number.isFinite(startMs)) return null;
  return formatUptime(nowMs - startMs);
}
