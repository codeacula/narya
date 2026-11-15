import type { DashboardStatus } from '../../../shared/api';
import { serviceStateTitle } from '../../connectionWords';

/**
 * What the Connections settings say about Twitch and its EventSub link, in the one
 * connected/offline vocabulary (connectionWords.ts) the stat bar and the service toasts
 * already use. Kept apart from the pages so the wording is testable.
 */

/**
 * How far the status these settings read from can be believed — the same distinction
 * the stat bar draws as dashes and "last known".
 * - `unknown`: nothing has arrived yet, so the status is the dashboard's placeholder.
 *   Its "not signed in" and "offline" are not facts and must not be said as facts.
 * - `stale`: Narya is not answering (statusIsStale). The values are what it last said.
 * - `fresh`: Narya said this recently.
 */
export type ConnectionsFreshness = 'unknown' | 'stale' | 'fresh';

export function connectionsFreshness({ known, stale }: { known: boolean; stale: boolean }): ConnectionsFreshness {
  if (!known) return 'unknown';
  return stale ? 'stale' : 'fresh';
}

/** The page's one line about how current it is, or null when it is current. */
export function connectionsFreshnessNote(freshness: ConnectionsFreshness): string | null {
  if (freshness === 'unknown') return 'Waiting for Narya to report the Twitch connection.';
  if (freshness === 'stale') return 'Narya is not answering. These are the last known states.';
  return null;
}

/** The EventSub row's sub line. A connected socket with refused subscriptions names them. */
export function eventSubSummary(
  status: Pick<DashboardStatus, 'eventSubConnected' | 'eventSubFailedSubscriptions'>,
  freshness: ConnectionsFreshness = 'fresh',
): string {
  if (freshness === 'unknown') return 'Not reported yet.';
  if (!status.eventSubConnected) return 'Offline. Log in with Twitch above to receive follows, subs and alerts.';
  const failed = status.eventSubFailedSubscriptions;
  if (failed.length === 0) return 'Receiving channel events';
  return `Connected, but these events aren't arriving: ${failed.join(', ')}. Re-authorize Twitch or check token scopes.`;
}

/** The EventSub row's badge. */
export function eventSubBadge(
  status: Pick<DashboardStatus, 'eventSubConnected' | 'eventSubFailedSubscriptions'>,
  freshness: ConnectionsFreshness = 'fresh',
): 'Connected' | 'Degraded' | 'Offline' | 'Unknown' {
  if (freshness === 'unknown') return 'Unknown';
  if (!status.eventSubConnected) return 'Offline';
  return status.eventSubFailedSubscriptions.length === 0 ? 'Connected' : 'Degraded';
}

type RailStatus = Pick<
  DashboardStatus,
  'twitchAuthenticated' | 'twitchMissingScopes' | 'eventSubConnected' | 'eventSubFailedSubscriptions'
>;

/**
 * The warning the settings rail puts on Connections. Twitch auth is the one settings
 * failure the operator can be looking away from: every other section is inert until it
 * works, so it is flagged from wherever they are.
 *
 * Nothing before the first status arrives: the placeholder reads as "not signed in",
 * which is not something Narya has said. While Narya is not answering, a warning it
 * last gave is marked as last known rather than repeated as current.
 */
export function connectionsRailWarning(status: RailStatus, freshness: ConnectionsFreshness = 'fresh'): string | null {
  if (freshness === 'unknown') return null;
  const warning = currentWarning(status);
  if (!warning) return null;
  return freshness === 'stale' ? `${warning} (last known)` : warning;
}

function currentWarning(status: RailStatus): string | null {
  if (!status.twitchAuthenticated) return 'Twitch offline: not signed in';
  if (status.twitchMissingScopes.length > 0) return `Twitch is missing scopes: ${status.twitchMissingScopes.join(', ')}`;
  if (!status.eventSubConnected) return serviceStateTitle('Twitch EventSub', false);
  if (status.eventSubFailedSubscriptions.length > 0) {
    return `These events are not arriving: ${status.eventSubFailedSubscriptions.join(', ')}`;
  }
  return null;
}
