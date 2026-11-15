/**
 * Lets only the newest of several overlapping requests land.
 *
 * A refresh that can be started again before the last one settles (a timer plus a
 * Retry button) used to apply whichever response arrived last — so a slow failure
 * could mark freshly loaded data stale, or an old snapshot could overwrite a newer
 * one. `begin()` stamps a request; the function it returns says whether that request
 * is still the newest, and only then may its outcome be applied.
 */
export function createLatestOnly(): { begin: () => () => boolean } {
  let generation = 0;
  return {
    begin() {
      const mine = ++generation;
      return () => mine === generation;
    },
  };
}
