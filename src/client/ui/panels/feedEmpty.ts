import type { LoadPhase } from '../../refreshHealth';

/**
 * What the chat panel and the activity feed say when there is nothing to draw, and
 * which controls end that state. Kept apart from the components so each reason is
 * written down once and tested.
 *
 * The rule: say *why* the list is empty. A load that has not landed is "loading", a
 * load that failed is "unavailable" with a Retry, an empty stream is "no … yet", and a
 * search or filter that hides everything says so and offers to clear itself, so the
 * operator never reads their own filter as a quiet stream.
 */
export type FeedEmptyAction = 'retry' | 'clear-search' | 'clear-filters';

export type FeedEmpty = {
  title: string;
  sub?: string;
  actions: FeedEmptyAction[];
};

/** A missing phase means the surface does not track loading (it always has its data). */
function unloaded(phase: LoadPhase | undefined, noun: string, what: string, items: string): FeedEmpty | null {
  if (phase === 'failed') {
    return {
      title: `${noun} unavailable`,
      sub: `Narya could not load recent ${what}. New ${items} still appear here as they arrive.`,
      actions: ['retry'],
    };
  }
  if (phase === 'loading') return { title: `Loading ${what}…`, actions: [] };
  return null;
}

export function chatEmpty({
  phase,
  total,
  visible,
  query,
}: {
  phase?: LoadPhase;
  /** Messages loaded. */
  total: number;
  /** Messages left after the search. */
  visible: number;
  query: string;
}): FeedEmpty | null {
  if (total === 0) {
    return unloaded(phase, 'Chat', 'chat', 'messages')
      ?? { title: 'No chat yet', sub: 'Messages appear here as viewers chat.', actions: [] };
  }
  if (visible > 0) return null;
  const q = query.trim();
  return {
    title: 'No matching messages',
    sub: `Nothing in the loaded chat matches “${q}”.`,
    actions: ['clear-search'],
  };
}

export function eventFeedEmpty({
  phase,
  total,
  visible,
  query,
  hiddenLabels,
  allHidden,
}: {
  phase?: LoadPhase;
  /** Events loaded. */
  total: number;
  /** Events left after the kind filters and the search. */
  visible: number;
  query: string;
  /** Labels of the hidden kinds that occur in the loaded events ("Follows", "Ad Breaks"). */
  hiddenLabels: string[];
  /** Every loaded event is of a hidden kind, so the filters alone empty the list. */
  allHidden: boolean;
}): FeedEmpty | null {
  if (total === 0) {
    return unloaded(phase, 'Activity', 'activity', 'events')
      ?? { title: 'No activity yet', sub: 'Follows, subs, cheers, raids and redeems appear here as they happen.', actions: [] };
  }
  if (visible > 0) return null;
  const q = query.trim();
  const hidden = hiddenLabels.join(', ');
  if (allHidden) {
    return {
      title: 'Everything is filtered out',
      sub: `${total} event${total === 1 ? '' : 's'} hidden by the kind filters (${hidden}).`,
      actions: q ? ['clear-filters', 'clear-search'] : ['clear-filters'],
    };
  }
  return {
    title: 'No matching activity',
    sub: hiddenLabels.length > 0
      ? `Nothing matches “${q}” in the kinds shown. Hidden: ${hidden}.`
      : `Nothing matches “${q}”.`,
    actions: hiddenLabels.length > 0 ? ['clear-search', 'clear-filters'] : ['clear-search'],
  };
}

export const FEED_EMPTY_ACTION_LABEL: Record<FeedEmptyAction, string> = {
  retry: 'Retry',
  'clear-search': 'Clear search',
  'clear-filters': 'Show all kinds',
};
