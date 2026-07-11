import React from 'react';
import type { DashboardStatus } from '../../shared/api';
import { withToken } from '../auth';
import { SettingsRow } from './settings/shared';
import { ConnectionsSection } from './settings/ConnectionsSection';
import { GoLiveSection } from './settings/GoLiveSection';
import { CommandsSection } from './settings/CommandsSection';
import { ContentSection } from './settings/ContentSection';
import { TtsSection } from './settings/TtsSection';
import { AlertsSection } from './settings/AlertsSection';
import { LlmSection } from './settings/LlmSection';

export function SettingsPage({
  status,
  onTwitchLogout,
  onTwitchBotLogout,
}: {
  status: DashboardStatus;
  onTwitchLogout: () => void;
  onTwitchBotLogout: () => void;
}) {
  const missingTwitchScopes = status.twitchMissingScopes.length > 0
    ? status.twitchMissingScopes.join(', ')
    : null;
  const twitchLoginSub = missingTwitchScopes
    ? `Reconnect to grant missing scopes: ${missingTwitchScopes}`
    : status.twitchAuthenticated
      ? `Credentials cached on backend${status.twitchAuthSource ? ` via ${status.twitchAuthSource}` : ''}`
      : 'Login to cache credentials for EventSub, Twitch uptime, and ad schedule data';
  const missingTwitchBotScopes = status.twitchBotMissingScopes.length > 0
    ? status.twitchBotMissingScopes.join(', ')
    : null;
  const twitchBotLoginSub = missingTwitchBotScopes
    ? `Reconnect to grant missing scopes: ${missingTwitchBotScopes}`
    : status.twitchBotAuthenticated
      ? `Bot credentials cached on backend${status.twitchBotAuthSource ? ` via ${status.twitchBotAuthSource}` : ''}`
      : 'Login as a bot account for dashboard chat messages';

  return (
    <div className="settings-page">
      <div className="settings-inner">
        <div className="settings-eyebrow">settings</div>
        <h2 className="settings-title">Control room</h2>
        <p className="set-intro">
          Twitch connection and backend integration settings.
        </p>

        <div className="set-group">
          <div className="set-group-label">Twitch connection</div>
          <SettingsRow
            label="Twitch login"
            sub={twitchLoginSub}
          >
            {missingTwitchScopes ? (
              <a className="btn-primary" href={withToken("/api/auth/twitch?force=1")}>Reconnect</a>
            ) : status.twitchAuthenticated && status.twitchAuthSource === 'oauth' ? (
              <button className="btn-primary" onClick={onTwitchLogout}>Disconnect</button>
            ) : status.twitchAuthenticated ? (
              <span className="set-badge set-badge--ok">Configured</span>
            ) : (
              <a className="btn-primary" href={withToken("/api/auth/twitch")}>
                Login with Twitch
              </a>
            )}
          </SettingsRow>
          <SettingsRow
            label="Bot login"
            sub={twitchBotLoginSub}
          >
            {missingTwitchBotScopes ? (
              <a className="btn-primary" href={withToken("/api/auth/twitch/bot?force=1")}>Reconnect bot</a>
            ) : status.twitchBotAuthenticated && status.twitchBotAuthSource === 'oauth' ? (
              <button className="btn-primary" onClick={onTwitchBotLogout}>Disconnect</button>
            ) : status.twitchBotAuthenticated ? (
              <span className="set-badge set-badge--ok">Configured</span>
            ) : (
              <a className="btn-primary" href={withToken("/api/auth/twitch/bot")}>
                Login as Bot
              </a>
            )}
          </SettingsRow>
          <SettingsRow
            label="EventSub"
            sub={status.eventSubConnected ? 'Receiving channel events' : 'Not connected - login to enable follows, subs, and alerts'}
          >
            {status.eventSubConnected ? (
              <span className="set-badge set-badge--ok">Connected</span>
            ) : (
              <span className="set-badge">Disconnected</span>
            )}
          </SettingsRow>
        </div>

        <ConnectionsSection eventSubConnected={status.eventSubConnected} />
        <GoLiveSection />
        <CommandsSection />
        <ContentSection />
        <TtsSection />
        <AlertsSection />
        <LlmSection />

        <p className="set-foot">
          More to come - hotkeys, OBS scenes.
        </p>
      </div>
    </div>
  );
}
