import type { DashboardStatus } from '../../shared/api';
import { withToken } from '../auth';
import { SettingsHeader, SettingsRow } from './settings/shared';
import { ConnectionsSection } from './settings/ConnectionsSection';
import { eventSubBadge, eventSubSummary } from './settings/connectionCopy';

/**
 * The Connections section — the landing page of the settings shell. Twitch sign-in sits
 * directly above the credentials it needs, because ConnectionsSection's own guidance
 * points at the "Login with Twitch" button here.
 */
export function ConnectionsSettingsPage({
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
    <>
      <SettingsHeader section="settings" />

      <div className="set-group">
        <div className="set-group-label">Twitch account</div>
        <SettingsRow
          label="Twitch login"
          sub={twitchLoginSub}
        >
          {missingTwitchScopes ? (
            <a className="btn-primary" href={withToken("/api/auth/twitch?force=1")}>Reconnect</a>
          ) : status.twitchAuthenticated && status.twitchAuthSource === 'oauth' ? (
            <button className="modbtn danger" type="button" onClick={onTwitchLogout}>Disconnect</button>
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
            <button className="modbtn danger" type="button" onClick={onTwitchBotLogout}>Disconnect</button>
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
          {/* A connected socket whose subscriptions Twitch refused still delivers
              nothing for those event types, so it is Degraded, not Connected. */}
          <span className={'set-badge' + (eventSubBadge(status) === 'Connected' ? ' set-badge--ok' : '')}>
            {eventSubBadge(status)}
          </span>
        </SettingsRow>
      </div>

      <ConnectionsSection
        eventSubConnected={status.eventSubConnected}
        redisConnected={status.redisConnected}
      />
    </>
  );
}
