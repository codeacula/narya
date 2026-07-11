import React from 'react';
import type { DashboardStatus } from '../../shared/api';
import { withToken } from '../auth';
import { SettingsRow } from './settings/shared';
import { ConnectionsSection } from './settings/ConnectionsSection';
import { GoLiveSection } from './settings/GoLiveSection';
import { ContentSection } from './settings/ContentSection';
import { TtsSection } from './settings/TtsSection';
import { LlmSection } from './settings/LlmSection';

// A connected socket whose subscriptions Twitch refused still delivers nothing for
// those event types, so name the ones that are dead instead of claiming health.
function eventSubSummary(status: DashboardStatus): string {
  if (!status.eventSubConnected) return 'Not connected - login to enable follows, subs, and alerts';
  const failed = status.eventSubFailedSubscriptions;
  if (failed.length === 0) return 'Receiving channel events';
  return `Connected, but these events aren't arriving: ${failed.join(', ')}. Re-authorize Twitch or check token scopes.`;
}

export function SettingsPage({
  status,
  onTwitchLogout,
  onTwitchBotLogout,
  onNavigate,
}: {
  status: DashboardStatus;
  onTwitchLogout: () => void;
  onTwitchBotLogout: () => void;
  onNavigate: (page: string) => void;
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
            sub={eventSubSummary(status)}
          >
            {status.eventSubConnected && status.eventSubFailedSubscriptions.length === 0 ? (
              <span className="set-badge set-badge--ok">Connected</span>
            ) : status.eventSubConnected ? (
              <span className="set-badge">Degraded</span>
            ) : (
              <span className="set-badge">Disconnected</span>
            )}
          </SettingsRow>
        </div>

        <div className="set-group">
          <div className="set-group-label">Automation platform</div>
          <SettingsRow
            label="Actions"
            sub="Named, reusable lists of steps: overlay text, media, TTS, chat, LLM, OBS, and Twitch moderation."
          >
            <button className="btn-primary" type="button" onClick={() => onNavigate('actions')}>Open</button>
          </SettingsRow>
          <SettingsRow
            label="Automation triggers"
            sub="What fires an action: rewards, Twitch events, chat phrases, !commands, /commands, manual buttons, and module lifecycle."
          >
            <button className="btn-primary" type="button" onClick={() => onNavigate('automation')}>Open</button>
          </SettingsRow>
          <SettingsRow
            label="Category modules"
            sub="A module owns Twitch categories and reward groups. Switching game swaps which one is active."
          >
            <button className="btn-primary" type="button" onClick={() => onNavigate('modules')}>Open</button>
          </SettingsRow>
        </div>

        <ConnectionsSection eventSubConnected={status.eventSubConnected} />
        <GoLiveSection />
        <ContentSection />
        <TtsSection />
        <LlmSection />

        <p className="set-foot">
          More to come - hotkeys, OBS scenes.
        </p>
      </div>
    </div>
  );
}
