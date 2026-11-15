import { formatAgo } from '../shared/time';

/**
 * Whether a list kept fresh in the background is still fresh.
 *
 * A background refresh (a poll, a refetch on a WebSocket nudge) used to swallow its
 * failure, so a dead backend left yesterday's list on screen looking current. Each
 * refresh now records its outcome here, and a failure after at least one success marks
 * the list stale until the next success clears it.
 *
 * A list that has never loaded is not "stale": there is nothing old on screen, and the
 * page's own load error already says what went wrong.
 */
export type RefreshHealth = {
  /** Epoch ms of the last refresh that succeeded, or null before the first. */
  lastSuccessAt: number | null;
  /** Failures since that success. */
  consecutiveFailures: number;
};

export const INITIAL_REFRESH_HEALTH: RefreshHealth = { lastSuccessAt: null, consecutiveFailures: 0 };

export function recordRefresh(health: RefreshHealth, ok: boolean, at: number): RefreshHealth {
  if (ok) return { lastSuccessAt: at, consecutiveFailures: 0 };
  return { ...health, consecutiveFailures: health.consecutiveFailures + 1 };
}

export function isStale(health: RefreshHealth): boolean {
  return health.lastSuccessAt !== null && health.consecutiveFailures > 0;
}

/** The quiet marker's wording, or null while the list is fresh. */
export function staleNoticeText(health: RefreshHealth): string | null {
  if (!isStale(health) || health.lastSuccessAt === null) return null;
  return `Couldn't refresh · last updated ${formatAgo(new Date(health.lastSuccessAt).toISOString())}`;
}

/**
 * Where a list that is loaded and then kept fresh stands, for choosing what an empty
 * list says. An empty list only means "nothing here" once a load has succeeded:
 * before that it is `loading`, and if every attempt so far has failed it is `failed`,
 * which must not be drawn as an empty stream. `stale` is a list that loaded once and
 * has failed since (see `isStale`).
 */
export type LoadPhase = 'loading' | 'failed' | 'fresh' | 'stale';

export function loadPhase(health: RefreshHealth): LoadPhase {
  if (health.lastSuccessAt === null) return health.consecutiveFailures > 0 ? 'failed' : 'loading';
  return health.consecutiveFailures > 0 ? 'stale' : 'fresh';
}
