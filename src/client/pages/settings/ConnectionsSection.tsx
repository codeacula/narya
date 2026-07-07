import React, { useEffect, useState } from 'react';
import type { AppConfig } from '../../../shared/api';
import { useToast } from '../../ui/notifications';
import { getAppConfig, updateAppConfig } from '../../services/dashboard';

type AppConfigForm = {
  twitchChannel: string;
  twitchClientId: string;
  twitchClientSecret: string;
  twitchClientSecretConfigured: boolean;
  clearTwitchClientSecret: boolean;
  obsUrl: string;
  obsPassword: string;
  obsPasswordConfigured: boolean;
  clearObsPassword: boolean;
  obsScenes: string;
  discordClientId: string;
  discordBotToken: string;
  discordBotTokenConfigured: boolean;
  clearDiscordBotToken: boolean;
  chatterboxBaseUrl: string;
  musicPollIntervalMs: number;
  musicPlayerctlPlayer: string;
  quackVolume: number;
};

function appConfigToForm(config: AppConfig): AppConfigForm {
  return {
    twitchChannel: config.twitchChannel,
    twitchClientId: config.twitchClientId,
    twitchClientSecret: '',
    twitchClientSecretConfigured: config.twitchClientSecretConfigured,
    clearTwitchClientSecret: false,
    obsUrl: config.obsUrl,
    obsPassword: '',
    obsPasswordConfigured: config.obsPasswordConfigured,
    clearObsPassword: false,
    obsScenes: config.obsScenes.join(', '),
    discordClientId: config.discordClientId,
    discordBotToken: '',
    discordBotTokenConfigured: config.discordBotTokenConfigured,
    clearDiscordBotToken: false,
    chatterboxBaseUrl: config.chatterboxBaseUrl,
    musicPollIntervalMs: config.musicPollIntervalMs,
    musicPlayerctlPlayer: config.musicPlayerctlPlayer,
    quackVolume: config.quackVolume,
  };
}

const EMPTY_APP_CONFIG_FORM: AppConfigForm = {
  twitchChannel: '',
  twitchClientId: '',
  twitchClientSecret: '',
  twitchClientSecretConfigured: false,
  clearTwitchClientSecret: false,
  obsUrl: '',
  obsPassword: '',
  obsPasswordConfigured: false,
  clearObsPassword: false,
  obsScenes: '',
  discordClientId: '',
  discordBotToken: '',
  discordBotTokenConfigured: false,
  clearDiscordBotToken: false,
  chatterboxBaseUrl: 'http://127.0.0.1:8008',
  musicPollIntervalMs: 2000,
  musicPlayerctlPlayer: '',
  quackVolume: 0.2,
};

export function ConnectionsSection({ eventSubConnected }: { eventSubConnected: boolean }) {
  const { pushToast } = useToast();
  const [appConfigForm, setAppConfigForm] = useState<AppConfigForm>(EMPTY_APP_CONFIG_FORM);
  const [appConfigLoading, setAppConfigLoading] = useState(true);
  const [appConfigSaving, setAppConfigSaving] = useState(false);
  const [appConfigMessage, setAppConfigMessage] = useState<string | null>(null);
  const [appConfigError, setAppConfigError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setAppConfigLoading(true);
    void getAppConfig()
      .then(config => {
        if (!cancelled) {
          setAppConfigForm(appConfigToForm(config));
          setAppConfigError(null);
        }
      })
      .catch(error => {
        if (!cancelled) setAppConfigError(error instanceof Error ? error.message : 'Could not load configuration');
      })
      .finally(() => {
        if (!cancelled) setAppConfigLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const handleAppConfigSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAppConfigSaving(true);
    setAppConfigMessage(null);
    setAppConfigError(null);
    void updateAppConfig({
      twitchChannel: appConfigForm.twitchChannel,
      twitchClientId: appConfigForm.twitchClientId,
      twitchClientSecret: appConfigForm.twitchClientSecret || undefined,
      clearTwitchClientSecret: appConfigForm.clearTwitchClientSecret,
      obsUrl: appConfigForm.obsUrl,
      obsPassword: appConfigForm.obsPassword || undefined,
      clearObsPassword: appConfigForm.clearObsPassword,
      obsScenes: appConfigForm.obsScenes.split(',').map(s => s.trim()).filter(Boolean),
      discordClientId: appConfigForm.discordClientId,
      discordBotToken: appConfigForm.discordBotToken || undefined,
      clearDiscordBotToken: appConfigForm.clearDiscordBotToken,
      chatterboxBaseUrl: appConfigForm.chatterboxBaseUrl,
      musicPollIntervalMs: appConfigForm.musicPollIntervalMs,
      musicPlayerctlPlayer: appConfigForm.musicPlayerctlPlayer,
      quackVolume: appConfigForm.quackVolume,
    })
      .then(config => {
        setAppConfigForm(appConfigToForm(config));
        setAppConfigMessage('Saved — reconnecting affected services.');
        // No success toast here: the settings:updated broadcast handler
        // (serviceStatus.tsx) already shows one in this same browser.
      })
      .catch(error => {
        const message = error instanceof Error ? error.message : 'Could not save configuration';
        setAppConfigError(message);
        pushToast({ kind: 'error', title: 'Could not save connections', message });
      })
      .finally(() => setAppConfigSaving(false));
  };

  return (
    <div className="set-group">
      <div className="set-group-label">Connections &amp; credentials</div>

      {!appConfigLoading && (!appConfigForm.twitchClientId || !appConfigForm.twitchClientSecretConfigured) && (
        <div className="settings-alert settings-alert--warn">
          <span className="settings-alert-icon">!</span>
          <span>
            Twitch app credentials are required for EventSub, uptime, and the ad schedule.
            Create an application at{' '}
            <a href="https://dev.twitch.tv/console/apps" target="_blank" rel="noopener noreferrer">
              dev.twitch.tv/console/apps
            </a>{' '}
            and paste the Client ID and Client Secret below.
          </span>
        </div>
      )}
      {!appConfigLoading && appConfigForm.twitchClientId && appConfigForm.twitchClientSecretConfigured
        && !eventSubConnected && (
        <div className="settings-alert settings-alert--info">
          <span className="settings-alert-icon">i</span>
          <span>
            Twitch app credentials are set but EventSub is not connected. Use “Login with Twitch”
            above to authorize, then events will start flowing.
          </span>
        </div>
      )}

      <form className="command-settings-form" onSubmit={handleAppConfigSubmit}>
        <label className="field">
          <span>Twitch channel</span>
          <input
            value={appConfigForm.twitchChannel}
            disabled={appConfigLoading || appConfigSaving}
            placeholder="codeacula"
            onChange={event => setAppConfigForm(current => ({ ...current, twitchChannel: event.target.value }))}
          />
        </label>

        <div className="connections-2col">
          <label className="field">
            <span>Twitch client ID</span>
            <input
              value={appConfigForm.twitchClientId}
              disabled={appConfigLoading || appConfigSaving}
              placeholder="From your Twitch developer application"
              onChange={event => setAppConfigForm(current => ({ ...current, twitchClientId: event.target.value }))}
            />
          </label>
          <div>
            <label className="field">
              <span>Twitch client secret</span>
              <input
                type="password"
                value={appConfigForm.twitchClientSecret}
                disabled={appConfigLoading || appConfigSaving || appConfigForm.clearTwitchClientSecret}
                placeholder={appConfigForm.twitchClientSecretConfigured ? 'Configured — leave blank to keep' : 'Client secret'}
                onChange={event => setAppConfigForm(current => ({ ...current, twitchClientSecret: event.target.value, clearTwitchClientSecret: false }))}
              />
            </label>
            {appConfigForm.twitchClientSecretConfigured && (
              <label className="command-enabled" style={{ marginTop: 8 }}>
                <input
                  type="checkbox"
                  checked={appConfigForm.clearTwitchClientSecret}
                  disabled={appConfigLoading || appConfigSaving}
                  onChange={event => setAppConfigForm(current => ({ ...current, clearTwitchClientSecret: event.target.checked, twitchClientSecret: '' }))}
                />
                <span>Clear stored client secret</span>
              </label>
            )}
          </div>
        </div>

        <div className="connections-2col">
          <label className="field">
            <span>OBS WebSocket URL</span>
            <input
              value={appConfigForm.obsUrl}
              disabled={appConfigLoading || appConfigSaving}
              placeholder="ws://127.0.0.1:4455"
              onChange={event => setAppConfigForm(current => ({ ...current, obsUrl: event.target.value }))}
            />
          </label>
          <div>
            <label className="field">
              <span>OBS WebSocket password</span>
              <input
                type="password"
                value={appConfigForm.obsPassword}
                disabled={appConfigLoading || appConfigSaving || appConfigForm.clearObsPassword}
                placeholder={appConfigForm.obsPasswordConfigured ? 'Configured — leave blank to keep' : 'Optional'}
                onChange={event => setAppConfigForm(current => ({ ...current, obsPassword: event.target.value, clearObsPassword: false }))}
              />
            </label>
            {appConfigForm.obsPasswordConfigured && (
              <label className="command-enabled" style={{ marginTop: 8 }}>
                <input
                  type="checkbox"
                  checked={appConfigForm.clearObsPassword}
                  disabled={appConfigLoading || appConfigSaving}
                  onChange={event => setAppConfigForm(current => ({ ...current, clearObsPassword: event.target.checked, obsPassword: '' }))}
                />
                <span>Clear stored OBS password</span>
              </label>
            )}
          </div>
        </div>

        <label className="field">
          <span>OBS scenes</span>
          <input
            value={appConfigForm.obsScenes}
            disabled={appConfigLoading || appConfigSaving}
            placeholder="Coding, BRB, Starting Soon, Ending"
            onChange={event => setAppConfigForm(current => ({ ...current, obsScenes: event.target.value }))}
          />
          <small>Comma-separated fallback scene list used before OBS connects.</small>
        </label>

        <div className="connections-2col">
          <label className="field">
            <span>Discord client ID</span>
            <input
              value={appConfigForm.discordClientId}
              disabled={appConfigLoading || appConfigSaving}
              placeholder="Discord application client ID"
              onChange={event => setAppConfigForm(current => ({ ...current, discordClientId: event.target.value }))}
            />
          </label>
          <div>
            <label className="field">
              <span>Discord bot token</span>
              <input
                type="password"
                value={appConfigForm.discordBotToken}
                disabled={appConfigLoading || appConfigSaving || appConfigForm.clearDiscordBotToken}
                placeholder={appConfigForm.discordBotTokenConfigured ? 'Configured — leave blank to keep' : 'Bot token'}
                onChange={event => setAppConfigForm(current => ({ ...current, discordBotToken: event.target.value, clearDiscordBotToken: false }))}
              />
            </label>
            {appConfigForm.discordBotTokenConfigured && (
              <label className="command-enabled" style={{ marginTop: 8 }}>
                <input
                  type="checkbox"
                  checked={appConfigForm.clearDiscordBotToken}
                  disabled={appConfigLoading || appConfigSaving}
                  onChange={event => setAppConfigForm(current => ({ ...current, clearDiscordBotToken: event.target.checked, discordBotToken: '' }))}
                />
                <span>Clear stored Discord bot token</span>
              </label>
            )}
          </div>
        </div>

        <label className="field">
          <span>Chatterbox URL</span>
          <input
            value={appConfigForm.chatterboxBaseUrl}
            disabled={appConfigLoading || appConfigSaving}
            placeholder="http://127.0.0.1:8008"
            onChange={event => setAppConfigForm(current => ({ ...current, chatterboxBaseUrl: event.target.value }))}
          />
        </label>

        <div className="llm-settings-grid">
          <label className="field">
            <span>Music poll interval (ms)</span>
            <input
              type="number"
              min="0"
              max="60000"
              step="500"
              value={appConfigForm.musicPollIntervalMs}
              disabled={appConfigLoading || appConfigSaving}
              onChange={event => setAppConfigForm(current => ({ ...current, musicPollIntervalMs: Number(event.target.value) }))}
            />
          </label>
          <label className="field">
            <span>playerctl player</span>
            <input
              value={appConfigForm.musicPlayerctlPlayer}
              disabled={appConfigLoading || appConfigSaving}
              placeholder="strawberry"
              onChange={event => setAppConfigForm(current => ({ ...current, musicPlayerctlPlayer: event.target.value }))}
            />
          </label>
          <label className="field">
            <span>Quack volume (0–1)</span>
            <input
              type="number"
              min="0"
              max="1"
              step="0.05"
              value={appConfigForm.quackVolume}
              disabled={appConfigLoading || appConfigSaving}
              onChange={event => setAppConfigForm(current => ({ ...current, quackVolume: Number(event.target.value) }))}
            />
          </label>
        </div>

        {(appConfigMessage || appConfigError) && (
          <div className={'command-settings-status' + (appConfigError ? ' error' : '')}>
            {appConfigError ?? appConfigMessage}
          </div>
        )}

        <div className="command-settings-actions">
          <button className="modbtn gold" type="submit" disabled={appConfigLoading || appConfigSaving}>
            {appConfigSaving ? 'Saving...' : 'Save connections'}
          </button>
        </div>
      </form>
    </div>
  );
}
