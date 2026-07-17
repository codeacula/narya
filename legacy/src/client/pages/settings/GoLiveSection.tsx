import React, { useEffect, useState } from 'react';
import type {
  DiscordChannel,
  DiscordGuild,
  DiscordStatus,
  GoLiveSettings,
  ObsStatus,
} from '../../../shared/api';
import { Icon } from '../../ui/icons';
import { withToken } from '../../auth';
import { SettingsRow } from './shared';
import {
  clearDiscordGoLiveSettings,
  getDiscordChannels,
  getDiscordGuilds,
  getDiscordStatus,
  getGoLiveSettings,
  getObsStatus,
  refreshDiscordStatus,
  updateGoLiveSettings,
} from '../../services/dashboard';

type GoLiveSettingsForm = GoLiveSettings;

const EMPTY_DISCORD_STATUS: DiscordStatus = {
  clientIdConfigured: false,
  botTokenConfigured: false,
  ready: false,
  botUser: null,
  installUrl: null,
  error: null,
};

const EMPTY_GO_LIVE_SETTINGS: GoLiveSettingsForm = {
  obsSceneName: '',
  discordGuildId: '',
  discordGuildName: '',
  discordChannelId: '',
  discordChannelName: '',
  discordMessage: '',
  updatedAt: null,
};

export function GoLiveSection() {
  const [discordStatus, setDiscordStatus] = useState<DiscordStatus>(EMPTY_DISCORD_STATUS);
  const [discordGuilds, setDiscordGuilds] = useState<DiscordGuild[]>([]);
  const [discordChannels, setDiscordChannels] = useState<DiscordChannel[]>([]);
  const [goLiveSettings, setGoLiveSettings] = useState<GoLiveSettingsForm>(EMPTY_GO_LIVE_SETTINGS);
  const [goLiveLoading, setGoLiveLoading] = useState(true);
  const [goLiveSaving, setGoLiveSaving] = useState(false);
  const [goLiveMessage, setGoLiveMessage] = useState<string | null>(null);
  const [goLiveError, setGoLiveError] = useState<string | null>(null);
  const [discordChannelsLoading, setDiscordChannelsLoading] = useState(false);
  const [discordHelpOpen, setDiscordHelpOpen] = useState(false);
  const [discordDisconnecting, setDiscordDisconnecting] = useState(false);
  const [discordRefreshing, setDiscordRefreshing] = useState(false);
  const [obsScenes, setObsScenes] = useState<string[]>([]);

  const discordConnectionSub = !discordStatus.clientIdConfigured
    ? 'Set the Discord client ID under Connections to enable bot install'
    : !discordStatus.botTokenConfigured
      ? 'Set the Discord bot token under Connections after creating the bot'
      : discordStatus.ready
        ? `Connected as ${discordStatus.botUser ?? 'Discord bot'}`
        : discordStatus.error ?? 'Discord bot unavailable';
  const goLiveSceneOptions = goLiveSettings.obsSceneName && !obsScenes.includes(goLiveSettings.obsSceneName)
    ? [goLiveSettings.obsSceneName, ...obsScenes]
    : obsScenes;

  useEffect(() => {
    let cancelled = false;
    void getObsStatus()
      .then(status => { if (!cancelled) setObsScenes(status.scenes); })
      .catch(() => { if (!cancelled) setObsScenes([]); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setGoLiveLoading(true);
    void Promise.all([getDiscordStatus(), getGoLiveSettings()])
      .then(async ([nextDiscordStatus, nextGoLiveSettings]) => {
        let nextGuilds: DiscordGuild[] = [];
        let nextChannels: DiscordChannel[] = [];
        let discordListError: string | null = null;
        if (nextDiscordStatus.ready) {
          try {
            nextGuilds = await getDiscordGuilds();
            if (nextGoLiveSettings.discordGuildId) {
              nextChannels = await getDiscordChannels(nextGoLiveSettings.discordGuildId);
            }
          } catch (error) {
            discordListError = error instanceof Error ? error.message : 'Could not load Discord servers';
          }
        }
        if (!cancelled) {
          setDiscordStatus(nextDiscordStatus);
          setGoLiveSettings(nextGoLiveSettings);
          setDiscordGuilds(nextGuilds);
          setDiscordChannels(nextChannels);
          setGoLiveError(discordListError);
        }
      })
      .catch(error => {
        if (!cancelled) setGoLiveError(error instanceof Error ? error.message : 'Could not load Discord settings');
      })
      .finally(() => {
        if (!cancelled) setGoLiveLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const handleDiscordGuildChange = (guildId: string) => {
    const guild = discordGuilds.find(item => item.id === guildId);
    setGoLiveSettings(current => ({
      ...current,
      discordGuildId: guild?.id ?? '',
      discordGuildName: guild?.name ?? '',
      discordChannelId: '',
      discordChannelName: '',
    }));
    setDiscordChannels([]);
    setGoLiveMessage(null);
    setGoLiveError(null);

    if (!guildId) return;
    setDiscordChannelsLoading(true);
    void getDiscordChannels(guildId)
      .then(setDiscordChannels)
      .catch(error => setGoLiveError(error instanceof Error ? error.message : 'Could not load Discord channels'))
      .finally(() => setDiscordChannelsLoading(false));
  };

  const handleDiscordChannelChange = (channelId: string) => {
    const channel = discordChannels.find(item => item.id === channelId);
    setGoLiveSettings(current => ({
      ...current,
      discordChannelId: channel?.id ?? '',
      discordChannelName: channel?.name ?? '',
    }));
    setGoLiveMessage(null);
    setGoLiveError(null);
  };

  const handleDiscordRefresh = () => {
    setDiscordRefreshing(true);
    setGoLiveError(null);
    void refreshDiscordStatus()
      .then(async nextStatus => {
        let nextGuilds: DiscordGuild[] = [];
        let nextChannels: DiscordChannel[] = [];
        let discordListError: string | null = null;
        if (nextStatus.ready) {
          try {
            nextGuilds = await getDiscordGuilds();
            if (goLiveSettings.discordGuildId) {
              nextChannels = await getDiscordChannels(goLiveSettings.discordGuildId);
            }
          } catch (error) {
            discordListError = error instanceof Error ? error.message : 'Could not load Discord servers';
          }
        }
        setDiscordStatus(nextStatus);
        setDiscordGuilds(nextGuilds);
        setDiscordChannels(nextChannels);
        setGoLiveError(discordListError);
      })
      .catch(error => setGoLiveError(error instanceof Error ? error.message : 'Could not refresh Discord status'))
      .finally(() => setDiscordRefreshing(false));
  };

  const handleDiscordDisconnect = () => {
    setDiscordDisconnecting(true);
    setGoLiveMessage(null);
    setGoLiveError(null);
    void clearDiscordGoLiveSettings()
      .then(saved => {
        setGoLiveSettings(saved);
        setDiscordChannels([]);
        setGoLiveMessage('Discord channel disconnected');
      })
      .catch(error => setGoLiveError(error instanceof Error ? error.message : 'Could not disconnect Discord'))
      .finally(() => setDiscordDisconnecting(false));
  };

  const handleGoLiveSettingsSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setGoLiveSaving(true);
    setGoLiveMessage(null);
    setGoLiveError(null);
    void updateGoLiveSettings({
      obsSceneName: goLiveSettings.obsSceneName,
      discordGuildId: goLiveSettings.discordGuildId,
      discordGuildName: goLiveSettings.discordGuildName,
      discordChannelId: goLiveSettings.discordChannelId,
      discordChannelName: goLiveSettings.discordChannelName,
      discordMessage: goLiveSettings.discordMessage,
    })
      .then(saved => {
        setGoLiveSettings(saved);
        setGoLiveMessage('Go Live settings saved');
      })
      .catch(error => setGoLiveError(error instanceof Error ? error.message : 'Could not save Go Live settings'))
      .finally(() => setGoLiveSaving(false));
  };

  return (
    <div className="set-group">
      <div className="set-group-label">Twitch live announcement</div>
      {(goLiveMessage || goLiveError) && (
        <div className={'set-status' + (goLiveError ? ' error' : '')}>
          {goLiveError ?? goLiveMessage}
        </div>
      )}

      <SettingsRow
        label={
          <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            Discord bot
            <button
              className="icon-btn"
              type="button"
              title="Discord bot setup instructions"
              onClick={() => setDiscordHelpOpen(true)}
              style={{ color: 'var(--fg-3)' }}
            >
              <Icon name="info" size={13} />
            </button>
          </span>
        }
        sub={discordConnectionSub}
      >
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          {discordStatus.ready ? (
            <>
              <span className="set-badge set-badge--ok">Connected</span>
              {discordStatus.installUrl && (
                <a className="btn-primary" href={withToken("/api/auth/discord")} style={{ fontSize: '11px' }}>
                  Reinstall
                </a>
              )}
            </>
          ) : discordStatus.installUrl ? (
            <a className="btn-primary" href={withToken("/api/auth/discord")}>
              Install Bot
            </a>
          ) : (
            <span className="set-badge">Not configured</span>
          )}
          {(discordStatus.clientIdConfigured || discordStatus.botTokenConfigured) && (
            <button
              className="icon-btn"
              type="button"
              title="Re-check Discord connection"
              disabled={discordRefreshing}
              onClick={handleDiscordRefresh}
              style={{ color: 'var(--fg-3)' }}
            >
              <Icon name="refresh" size={13} />
            </button>
          )}
        </div>
      </SettingsRow>

      {discordHelpOpen && (
        <div className="modal-backdrop" onMouseDown={event => {
          if (event.target === event.currentTarget) setDiscordHelpOpen(false);
        }}>
          <div className="discord-help-modal">
            <div className="modal-head">
              <h2>Discord bot setup</h2>
              <button className="icon-btn" type="button" title="Close" onClick={() => setDiscordHelpOpen(false)}>
                <Icon name="x" />
              </button>
            </div>
            <ol className="discord-help-steps">
              <li>
                Go to{' '}
                <a href="https://discord.com/developers/applications" target="_blank" rel="noopener noreferrer">
                  discord.com/developers/applications
                </a>{' '}
                and create a new application.
              </li>
              <li>
                Under <b>Bot</b>, click <b>Add Bot</b>, then copy the token.
                Paste it into <b>Discord bot token</b> under Connections &amp; credentials.
              </li>
              <li>
                Copy the <b>Application ID</b> from the General Information page.
                Paste it into <b>Discord client ID</b> under Connections &amp; credentials.
              </li>
              <li>
                Under <b>OAuth2 → Redirects</b>, add the redirect URI that matches your setup:
                <ul className="discord-help-uris">
                  <li><b>Local dev (Vite):</b> <code>http://localhost:5173/api/auth/discord/callback</code></li>
                  <li><b>Production (served by backend):</b> <code>http://localhost:4317/api/auth/discord/callback</code></li>
                </ul>
                Set <code>DISCORD_REDIRECT_URI</code> in your <code>.env</code> to match (deploy-specific).
              </li>
              <li>Click <b>Install Bot</b> here to add it to your server.</li>
            </ol>
            <div className="modal-actions">
              <button className="modbtn gold" type="button" onClick={() => setDiscordHelpOpen(false)}>Got it</button>
            </div>
          </div>
        </div>
      )}

      <div className="settings-editor-section">
      <form className="settings-mini-form" onSubmit={handleGoLiveSettingsSubmit}>
        <label className="field">
          <span>Starting scene</span>
          {goLiveSceneOptions.length > 0 ? (
            <select
              value={goLiveSettings.obsSceneName}
              disabled={goLiveLoading || goLiveSaving}
              onChange={event => setGoLiveSettings(current => ({ ...current, obsSceneName: event.target.value }))}
            >
              <option value="">Select a scene</option>
              {goLiveSceneOptions.map(scene => (
                <option value={scene} key={scene}>{scene}</option>
              ))}
            </select>
          ) : (
            <input
              value={goLiveSettings.obsSceneName}
              disabled={goLiveLoading || goLiveSaving}
              maxLength={160}
              placeholder="Starting Soon"
              onChange={event => setGoLiveSettings(current => ({ ...current, obsSceneName: event.target.value }))}
            />
          )}
        </label>

        <label className="field">
          <span>Server</span>
          <select
            value={goLiveSettings.discordGuildId}
            disabled={goLiveLoading || goLiveSaving || discordGuilds.length === 0}
            onChange={event => handleDiscordGuildChange(event.target.value)}
          >
            <option value="">Select a server</option>
            {discordGuilds.map(guild => (
              <option value={guild.id} key={guild.id}>{guild.name}</option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Channel</span>
          <select
            value={goLiveSettings.discordChannelId}
            disabled={goLiveLoading || goLiveSaving || discordChannelsLoading || discordChannels.length === 0}
            onChange={event => handleDiscordChannelChange(event.target.value)}
          >
            <option value="">{discordChannelsLoading ? 'Loading channels...' : 'Select a channel'}</option>
            {discordChannels.map(channel => (
              <option value={channel.id} key={channel.id}>
                #{channel.name}{channel.type === 'announcement' ? ' (announcement)' : ''}
              </option>
            ))}
          </select>
        </label>

        <label className="field settings-wide-field">
          <span>Announcement</span>
          <textarea
            value={goLiveSettings.discordMessage}
            disabled={goLiveLoading || goLiveSaving}
            maxLength={2000}
            rows={4}
            placeholder="I'm live now playing {category}: {title} https://twitch.tv/{channel}"
            onChange={event => setGoLiveSettings(current => ({ ...current, discordMessage: event.target.value }))}
          />
          <small>
            {goLiveSettings.discordMessage.length}/2000 · variables: <code>{'{title}'}</code> <code>{'{category}'}</code> <code>{'{channel}'}</code> <code>{'{url}'}</code>
          </small>
        </label>

        <div className="command-settings-actions">
          <button className="modbtn gold" type="submit" disabled={goLiveLoading || goLiveSaving}>
            {goLiveSaving ? 'Saving...' : 'Save live settings'}
          </button>
          {goLiveSettings.discordChannelId && (
            <button
              className="modbtn danger"
              type="button"
              disabled={goLiveLoading || goLiveSaving || discordDisconnecting}
              onClick={handleDiscordDisconnect}
            >
              {discordDisconnecting ? 'Disconnecting...' : 'Disconnect Discord'}
            </button>
          )}
        </div>
      </form>
      </div>
    </div>
  );
}
