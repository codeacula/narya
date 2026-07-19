/**
 * Queue primitives shared by the overlay playback lanes (clips and text).
 *
 * The cap and the warning wording belong to each caller: the operator reads the
 * warning to tell which overlay dropped the item.
 */

/** Append unless the id is already queued — a replayed socket event must not double-play. */
export function enqueueUnique<T extends { id: string }>(queue: T[], item: T, max: number, label: string): T[] {
  if (queue.some(queued => queued.id === item.id)) return queue;
  if (queue.length >= max) {
    console.warn(label);
    return queue;
  }
  return [...queue, item];
}

/**
 * Drop the head, but only if `id` still names it. A failing item can report
 * completion twice; without this check the second one would drop the item behind it.
 */
export function advanceHead<T extends { id: string }>(queue: T[], id: string): T[] {
  if (queue[0]?.id !== id) return queue;
  return queue.slice(1);
}
