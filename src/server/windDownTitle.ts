/**
 * Composing the wind-down title, kept pure and dependency-free so the 140-character
 * rule is testable on its own.
 *
 * `base_title` in the wind_down_state row is always the operator's real title. The
 * live title is ALWAYS recomputed as base + suffix and never appended to whatever is
 * currently on the channel, so toggling wind-down twice cannot stack suffixes.
 */

/** Twitch's hard limit. A PATCH over this is rejected, and a rejected PATCH is silent. */
export const MAX_TWITCH_TITLE_LENGTH = 140;

/** Below this fraction of the available room, a word-boundary cut wastes too much. */
const WORD_BOUNDARY_MIN_RATIO = 0.6;

export function composeWindDownTitle(baseTitle: string, suffix: string): string {
  const base = baseTitle.trim();
  const tail = suffix.trim();
  if (!tail) return base;

  const combined = base ? `${base} ${tail}` : tail;
  if (combined.length <= MAX_TWITCH_TITLE_LENGTH) return combined;

  // Room left for the base once the separator space and the ellipsis are reserved.
  const room = MAX_TWITCH_TITLE_LENGTH - tail.length - 2;
  // A suffix that cannot fit at all: keep as much of it as Twitch will take. The
  // Settings form rejects this case up front; this is the belt-and-braces path.
  if (room <= 0) return tail.slice(0, MAX_TWITCH_TITLE_LENGTH);

  const cut = base.slice(0, room);
  const lastSpace = cut.lastIndexOf(' ');
  const trimmed = (lastSpace > room * WORD_BOUNDARY_MIN_RATIO ? cut.slice(0, lastSpace) : cut).trimEnd();
  return `${trimmed}… ${tail}`;
}

/**
 * Recover the operator's title from one that already carries the suffix.
 *
 * Needed when the operator edits the title mid-wind-down: they are editing the
 * suffixed title they can see, so their submission must be re-based rather than
 * stored verbatim, or the next compose would append a second suffix.
 */
export function stripWindDownSuffix(title: string, suffix: string): string {
  const value = title.trim();
  const tail = suffix.trim();
  if (!tail || !value.endsWith(tail)) return value;
  return value.slice(0, value.length - tail.length).trimEnd().replace(/…$/, '').trimEnd();
}
