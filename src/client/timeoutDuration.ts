/**
 * Timeout durations, shared by the viewer action modal's preset chips and the
 * one-click timeout on a chat row.
 *
 * Moderation is time-critical mid-stream, so the durations an operator actually
 * reaches for are one click rather than something to type. The custom field
 * stays for everything else.
 */

/** Twitch's ceiling for a timeout: 14 days. Anything longer has to be a ban. */
export const MAX_TIMEOUT_MINUTES = 20_160;

/**
 * What an unqualified "time them out" means. Both the chat-row button and the
 * modal's initial selection use it, so the two surfaces can't disagree about
 * what the default punishment is.
 */
export const DEFAULT_TIMEOUT_MINUTES = 10;

export type TimeoutPreset = { minutes: number; label: string };

export const TIMEOUT_PRESETS: TimeoutPreset[] = [
  { minutes: 1, label: '1m' },
  { minutes: 5, label: '5m' },
  { minutes: DEFAULT_TIMEOUT_MINUTES, label: '10m' },
  { minutes: 60, label: '1h' },
  { minutes: 1_440, label: '24h' },
  { minutes: 10_080, label: '7d' },
];

/**
 * Compact label for a duration — "10m", "1h", "7d". A preset value keeps the
 * preset's own wording (1440 reads as "24h", not "1d") so the confirm button
 * says the same thing as the chip the operator just clicked.
 */
export function timeoutLabel(minutes: number): string {
  const preset = TIMEOUT_PRESETS.find(entry => entry.minutes === minutes);
  if (preset) return preset.label;
  if (!Number.isFinite(minutes) || minutes <= 0) return '—';
  if (minutes % 1_440 === 0) return `${minutes / 1_440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

/**
 * Whether a duration can be submitted. The server answers anything outside this
 * range with a 400, so the confirm button disables rather than round-tripping to
 * find that out.
 */
export function isValidTimeoutMinutes(minutes: number): boolean {
  return Number.isFinite(minutes) && minutes >= 1 && minutes <= MAX_TIMEOUT_MINUTES;
}

/**
 * What the modal will submit, derived rather than held in its own state so the
 * chips and the custom field cannot drift apart. A non-empty custom field wins
 * and deselects every chip; clearing it falls back to the selected preset rather
 * than leaving the form with nothing chosen.
 */
export function resolveTimeoutMinutes(presetMinutes: number, customField: string): number {
  const custom = customField.trim();
  if (!custom) return presetMinutes;
  return Number(custom);
}

/**
 * Minutes → the seconds the API takes. Clamps rather than substituting a
 * default: an operator who typed 30000 meant "a long time", and silently
 * serving them 10 minutes would be worse than serving them the 14-day ceiling.
 */
export function timeoutSeconds(minutes: number): number {
  if (!Number.isFinite(minutes)) return DEFAULT_TIMEOUT_MINUTES * 60;
  return Math.round(Math.min(Math.max(minutes, 1), MAX_TIMEOUT_MINUTES) * 60);
}
