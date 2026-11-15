import React from 'react';
import type { DashboardStatus, DiscordAnnounceFailedPayload, SettingsUpdatedPayload } from '../../shared/api';
import { useSocket } from '../realtime';
import { useToast } from './notifications';
import { settingsEcho } from '../settingsEcho';
import { serviceSnapshot, serviceTransitionToasts, type ServiceSnapshot } from './serviceTransitions';

// Watches live service status and settings changes, surfacing transient toasts with
// guidance when something connects, drops, or needs configuration. Titles use the one
// "connected"/"offline" vocabulary from connectionWords.ts, so a toast says the same
// word as the stat bar and the tablet chip (see serviceTransitions.ts). Inline,
// persistent alerts on the Settings page complement these for issues that need operator action.
export function ServiceStatusToasts() {
  const { pushToast } = useToast();
  const previous = React.useRef<ServiceSnapshot | null>(null);

  const onStatus = React.useCallback((status: DashboardStatus) => {
    const toasts = serviceTransitionToasts(previous.current, status);
    previous.current = serviceSnapshot(status);
    for (const toast of toasts) pushToast(toast);
  }, [pushToast]);

  // A save made in this window is already reported beside its form, so only a save
  // made elsewhere (another dashboard window) is worth a toast here (settingsEcho.ts).
  const onSettings = React.useCallback((payload: SettingsUpdatedPayload) => {
    if (settingsEcho.isOwnEcho(payload.updatedAt)) return;
    pushToast({
      kind: 'info',
      title: 'Settings saved elsewhere',
      message: 'Another window changed the settings. Reconnecting affected services…',
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
