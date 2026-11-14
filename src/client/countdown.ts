import React from 'react';

const SECOND_MS = 1000;

/**
 * "mm:ss" under an hour, "h:mm:ss" from an hour up. Past zero it keeps going with a
 * minus sign ("-02:15"), which Starting soon and Be right back rely on to show a stream
 * that is running late; the ad banner hides at zero instead and never gets there.
 *
 * Rounding: while time remains the label rounds UP, so a countdown never shows a second
 * less than is left (59.001s reads 01:00). Once overdue it rounds toward zero, so
 * the minus label counts whole seconds actually elapsed and -1ms is "00:00", never
 * "-00:00". Anything non-finite reads "00:00".
 *
 * This is deliberately not windDownCountdown.ts, whose coarse "~25 min left" wording is
 * written for raiders glancing at a card, not for a ticking clock.
 */
export function formatCountdown(msRemaining: number): string {
  if (!Number.isFinite(msRemaining)) return '00:00';
  const seconds = msRemaining >= 0
    ? Math.ceil(msRemaining / SECOND_MS)
    : -Math.floor(-msRemaining / SECOND_MS);
  const sign = seconds < 0 ? '-' : '';
  const abs = Math.abs(seconds);
  const hours = Math.floor(abs / 3600);
  const minutes = Math.floor((abs % 3600) / 60);
  const secs = abs % 60;
  const mmss = `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  return hours > 0 ? `${sign}${hours}:${mmss}` : `${sign}${mmss}`;
}

export type CountdownReading = { msRemaining: number; label: string };

/**
 * Ticks once a second while `endsAt` is set and returns the time left (negative once
 * past) with its formatted label; null when there is no end time or it cannot be parsed.
 * No interval runs while idle.
 */
export function useCountdown(endsAt: string | null): CountdownReading | null {
  const [now, setNow] = React.useState(() => Date.now());

  React.useEffect(() => {
    if (!endsAt) return;
    // Re-read the clock immediately: the state may be stale from before the end time was set.
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), SECOND_MS);
    return () => clearInterval(timer);
  }, [endsAt]);

  if (!endsAt) return null;
  const endMs = new Date(endsAt).getTime();
  if (!Number.isFinite(endMs)) return null;
  const msRemaining = endMs - now;
  return { msRemaining, label: formatCountdown(msRemaining) };
}

/** The one gold ticking value, shared by every scene that counts toward a time. */
export function Countdown({ endsAt, className }: { endsAt: string | null; className?: string }) {
  const reading = useCountdown(endsAt);
  if (!reading) return null;
  return React.createElement('span', { className }, reading.label);
}
