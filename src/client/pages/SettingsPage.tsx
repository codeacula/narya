import React from 'react';
import type { DashboardStatus } from '../../shared/api';
import { withToken } from '../auth';
import { errorMessage } from '../errors';
import { disconnectTwitch } from '../services/dashboard';
import { useConfirm } from '../ui/confirm';
import { SettingsHeader, SettingsRow, SettingsStatus } from './settings/shared';
import { ConnectionsSection } from './settings/ConnectionsSection';
import {
  connectionsFreshnessNote,
  eventSubBadge,
  eventSubSummary,
  type ConnectionsFreshness,
} from './settings/connectionCopy';

type TwitchAccount = 'user' | 'bot';

const ACCOUNT_NAME: Record<TwitchAccount, string> = {
  user: 'your Twitch account',
  bot: 'the bot account',
};

const DISCONNECT_CONSEQUENCE: Record<TwitchAccount, string> = {
  user: 'Alerts, EventSub and the ad schedule stop until you sign in again.',
  bot: 'Dashboard chat messages will stop sending as the bot until you sign it in again.',
};

/**
 * The Connections section — the landing page of the settings shell. Twitch sign-in sits
 * directly above the credentials it needs, because ConnectionsSection's own guidance
 * points at the "Login with Twitch" button here.
 *
 * `freshness` says whether `status` is something Narya reported (connectionCopy.ts).
 * Until it is, the sign-in rows say nothing about being signed in or out, and offer
 * neither Login nor Disconnect: either could be the wrong button.
 */
export function ConnectionsSettingsPage({
  status,
  freshness,
  onTwitchDisconnected,
}: {
  status: DashboardStatus;
  freshness: ConnectionsFreshness;
  /** An account was signed out; re-read the status so the rows reflect it. */
  onTwitchDisconnected: () => void;
}) {
  const confirm = useConfirm();
  const [disconnecting, setDisconnecting] = React.useState<TwitchAccount | null>(null);
  const [message, setMessage] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const unknown = freshness === 'unknown';
  const freshnessNote = connectionsFreshnessNote(freshness);

  // Disconnecting drops EventSub, alerts and the ad schedule until the next sign-in, so
  // it confirms first, and its outcome is reported on this page's status line — where
  // the operator who pressed it is looking — rather than in a toast.
  const disconnect = async (account: TwitchAccount) => {
    const what = ACCOUNT_NAME[account];
    const ok = await confirm({
      title: `Disconnect ${what}?`,
      body: DISCONNECT_CONSEQUENCE[account],
      confirmLabel: 'Disconnect',
      tone: 'danger',
    });
    if (!ok) return;
    setDisconnecting(account);
    setMessage(null);
    setError(null);
    try {
      await disconnectTwitch(account);
      setMessage(`Disconnected ${what}.`);
      onTwitchDisconnected();
    } catch (caught) {
      setError(`Could not disconnect ${what}: ${errorMessage(caught, 'the server did not respond.')}`);
    } finally {
      setDisconnecting(null);
    }
  };

  const missingTwitchScopes = status.twitchMissingScopes.length > 0
    ? status.twitchMissingScopes.join(', ')
    : null;
  const twitchLoginSub = unknown
    ? 'Not reported yet.'
    : missingTwitchScopes
      ? `Reconnect to grant missing scopes: ${missingTwitchScopes}`
      : status.twitchAuthenticated
        ? `Credentials cached on backend${status.twitchAuthSource ? ` via ${status.twitchAuthSource}` : ''}`
        : 'Login to cache credentials for EventSub, Twitch uptime, and ad schedule data';
  const missingTwitchBotScopes = status.twitchBotMissingScopes.length > 0
    ? status.twitchBotMissingScopes.join(', ')
    : null;
  const twitchBotLoginSub = unknown
    ? 'Not reported yet.'
    : missingTwitchBotScopes
      ? `Reconnect to grant missing scopes: ${missingTwitchBotScopes}`
      : status.twitchBotAuthenticated
        ? `Bot credentials cached on backend${status.twitchBotAuthSource ? ` via ${status.twitchBotAuthSource}` : ''}`
        : 'Login as a bot account for dashboard chat messages';
  const badge = eventSubBadge(status, freshness);

  return (
    <>
      <SettingsHeader section="settings" />

      <SettingsStatus message={message} error={error} />

      <div className="set-group">
        <div className="set-group-label">Twitch account</div>
        {/* The spoken half is always mounted, so a change of state is announced (a
            region inserted with its text often is not); the drawn line comes and goes. */}
        <div className="sr-only" role="status">{freshnessNote}</div>
        {freshnessNote ? <div className="stale-notice set-freshness" aria-hidden="true">{freshnessNote}</div> : null}
        <SettingsRow
          label="Twitch login"
          sub={twitchLoginSub}
        >
          {unknown ? (
            <span className="set-badge">Unknown</span>
          ) : missingTwitchScopes ? (
            <a className="btn-primary" href={withToken("/api/auth/twitch?force=1")}>Reconnect</a>
          ) : status.twitchAuthenticated && status.twitchAuthSource === 'oauth' ? (
            <button
              className="modbtn danger"
              type="button"
              disabled={disconnecting !== null}
              onClick={() => void disconnect('user')}
            >
              {disconnecting === 'user' ? 'Disconnecting…' : 'Disconnect'}
            </button>
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
          {unknown ? (
            <span className="set-badge">Unknown</span>
          ) : missingTwitchBotScopes ? (
            <a className="btn-primary" href={withToken("/api/auth/twitch/bot?force=1")}>Reconnect bot</a>
          ) : status.twitchBotAuthenticated && status.twitchBotAuthSource === 'oauth' ? (
            <button
              className="modbtn danger"
              type="button"
              disabled={disconnecting !== null}
              onClick={() => void disconnect('bot')}
            >
              {disconnecting === 'bot' ? 'Disconnecting…' : 'Disconnect'}
            </button>
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
          sub={eventSubSummary(status, freshness)}
        >
          {/* A connected socket whose subscriptions Twitch refused still delivers
              nothing for those event types, so it is Degraded, not Connected. */}
          <span className={'set-badge' + (badge === 'Connected' ? ' set-badge--ok' : '')}>
            {badge}
          </span>
        </SettingsRow>
      </div>

      <ConnectionsSection
        statusKnown={!unknown}
        eventSubConnected={status.eventSubConnected}
        redisConnected={status.redisConnected}
      />
    </>
  );
}
