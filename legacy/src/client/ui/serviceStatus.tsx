import React from 'react';
import type { DashboardStatus, DiscordAnnounceFailedPayload, SettingsUpdatedPayload } from '../../shared/api';
import { useSocket } from '../realtime';
import { useToast } from './notifications';

// Watches live service status and settings changes, surfacing transient toasts with
// guidance when something connects, drops, or needs configuration. Inline, persistent
// alerts on the Settings page complement these for issues that need operator action.
export function ServiceStatusToasts() {
  const { pushToast } = useToast();
  const previous = React.useRef<{ obs: boolean; eventSub: boolean } | null>(null);

  const onStatus = React.useCallback((status: DashboardStatus) => {
    const prev = previous.current;
    previous.current = { obs: status.obsConnected, eventSub: status.eventSubConnected };
    if (!prev) return; // Skip the first snapshot so we only report transitions.

    if (prev.obs && !status.obsConnected) {
      pushToast({
        kind: 'error',
        title: 'OBS disconnected',
        message: 'Check the OBS WebSocket URL and password in Settings → Connections.',
      });
    } else if (!prev.obs && status.obsConnected) {
      pushToast({ kind: 'success', title: 'OBS connected' });
    }

    if (prev.eventSub && !status.eventSubConnected) {
      pushToast({
        kind: 'error',
        title: 'Twitch EventSub disconnected',
        message: status.eventSubError
          ?? 'Reconnect Twitch or check the client ID/secret in Settings → Connections.',
      });
    } else if (!prev.eventSub && status.eventSubConnected) {
      pushToast({ kind: 'success', title: 'Twitch EventSub connected' });
    }
  }, [pushToast]);

  const onSettings = React.useCallback((_payload: SettingsUpdatedPayload) => {
    pushToast({
      kind: 'info',
      title: 'Settings saved',
      message: 'Reconnecting affected services…',
      durationMs: 4000,
    });
  }, [pushToast]);

  const onDiscordAnnounceFailed = React.useCallback((payload: DiscordAnnounceFailedPayload) => {
    const channel = payload.channelName ? `#${payload.channelName}` : 'the announcement channel';
    pushToast({
      kind: 'error',
      title: 'Discord announcement failed',
      message: `${payload.reason} Check the bot's Send Messages permission in ${channel}.`,
    });
  }, [pushToast]);

  useSocket<DashboardStatus>('dashboard:status', onStatus);
  useSocket<SettingsUpdatedPayload>('settings:updated', onSettings);
  useSocket<DiscordAnnounceFailedPayload>('discord:announce-failed', onDiscordAnnounceFailed);

  return null;
}
