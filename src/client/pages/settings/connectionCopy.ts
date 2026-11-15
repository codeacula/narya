import type { DashboardStatus } from '../../../shared/api';
import { serviceStateTitle } from '../../connectionWords';

/**
 * What the Connections settings say about Twitch and its EventSub link, in the one
 * connected/offline vocabulary (connectionWords.ts) the stat bar and the service toasts
 * already use. Kept apart from the pages so the wording is testable.
 */

/** The EventSub row's sub line. A connected socket with refused subscriptions names them. */
export function eventSubSummary(status: Pick<DashboardStatus, 'eventSubConnected' | 'eventSubFailedSubscriptions'>): string {
  if (!status.eventSubConnected) return 'Offline. Log in with Twitch above to receive follows, subs and alerts.';
  const failed = status.eventSubFailedSubscriptions;
  if (failed.length === 0) return 'Receiving channel events';
  return `Connected, but these events aren't arriving: ${failed.join(', ')}. Re-authorize Twitch or check token scopes.`;
}

/** The EventSub row's badge. */
export function eventSubBadge(status: Pick<DashboardStatus, 'eventSubConnected' | 'eventSubFailedSubscriptions'>): 'Connected' | 'Degraded' | 'Offline' {
  if (!status.eventSubConnected) return 'Offline';
  return status.eventSubFailedSubscriptions.length === 0 ? 'Connected' : 'Degraded';
}

/**
 * The warning the settings rail puts on Connections. Twitch auth is the one settings
 * failure the operator can be looking away from: every other section is inert until it
 * works, so it is flagged from wherever they are.
 */
export function connectionsRailWarning(
  status: Pick<DashboardStatus, 'twitchAuthenticated' | 'twitchMissingScopes' | 'eventSubConnected' | 'eventSubFailedSubscriptions'>,
): string | null {
  if (!status.twitchAuthenticated) return 'Twitch offline: not signed in';
  if (status.twitchMissingScopes.length > 0) return `Twitch is missing scopes: ${status.twitchMissingScopes.join(', ')}`;
  if (!status.eventSubConnected) return serviceStateTitle('Twitch EventSub', false);
  if (status.eventSubFailedSubscriptions.length > 0) {
    return `These events are not arriving: ${status.eventSubFailedSubscriptions.join(', ')}`;
  }
  return null;
}
