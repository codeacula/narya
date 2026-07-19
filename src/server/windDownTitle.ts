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

/**
 * Slice `value` to at most `maxLength` UTF-16 code units, then drop a trailing dangling
 * high surrogate (U+D800–U+DBFF) if the cut landed inside an astral character (e.g. an
 * emoji, which spans two UTF-16 code units). A plain `value.slice(0, maxLength)` can
 * leave exactly that dangling high surrogate when the cut point falls between it and its
 * low-surrogate partner — the result's `.length` still satisfies any `<= maxLength`
 * guard, so a length check alone never catches this. But encoding a lone surrogate to
 * UTF-8 (which any HTTP client does before sending the Twitch PATCH body) turns it into
 * U+FFFD, corrupting the title. Do not "simplify" this away: the check below is what
 * makes the guard actually work.
 */
function sliceWithoutDanglingSurrogate(value: string, maxLength: number): string {
  const cut = value.slice(0, maxLength);
  const lastCode = cut.charCodeAt(cut.length - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    return cut.slice(0, -1);
  }
  return cut;
}

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
  if (room <= 0) return sliceWithoutDanglingSurrogate(tail, MAX_TWITCH_TITLE_LENGTH);

  const cut = sliceWithoutDanglingSurrogate(base, room);
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
