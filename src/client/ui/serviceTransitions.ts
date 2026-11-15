import type { DashboardStatus } from '../../shared/api';
import { OBS_OFFLINE, serviceStateTitle } from '../connectionWords';

export type ServiceSnapshot = { obs: boolean; eventSub: boolean; redis: boolean };

export type ServiceToast = { kind: 'success' | 'error'; title: string; message?: string };

export function serviceSnapshot(status: DashboardStatus): ServiceSnapshot {
  return { obs: status.obsConnected, eventSub: status.eventSubConnected, redis: status.redisConnected };
}

/**
 * The toasts for one `dashboard:status` heartbeat, given the one before it. Only a
 * change is worth a toast: the first snapshot (`prev` null) and a steady state say
 * nothing. Titles take the shared "connected"/"offline" words (connectionWords.ts).
 */
export function serviceTransitionToasts(prev: ServiceSnapshot | null, status: DashboardStatus): ServiceToast[] {
  if (!prev) return [];
  const toasts: ServiceToast[] = [];

  if (prev.obs && !status.obsConnected) {
    toasts.push({
      kind: 'error',
      title: OBS_OFFLINE,
      message: 'Check the OBS WebSocket URL and password in Settings → Connections.',
    });
  } else if (!prev.obs && status.obsConnected) {
    toasts.push({ kind: 'success', title: serviceStateTitle('OBS', true) });
  }

  if (prev.eventSub && !status.eventSubConnected) {
    toasts.push({
      kind: 'error',
      title: serviceStateTitle('Twitch EventSub', false),
      message: status.eventSubError
        ?? 'Reconnect Twitch or check the client ID/secret in Settings → Connections.',
    });
  } else if (!prev.eventSub && status.eventSubConnected) {
    toasts.push({ kind: 'success', title: serviceStateTitle('Twitch EventSub', true) });
  }

  if (prev.redis && !status.redisConnected) {
    toasts.push({
      kind: 'error',
      title: serviceStateTitle('Redis', false),
      message: status.lastPublishError ?? 'Check the Redis URL in Settings → Connections.',
    });
  } else if (!prev.redis && status.redisConnected) {
    toasts.push({ kind: 'success', title: serviceStateTitle('Redis', true) });
  }

  return toasts;
}
