import React, { useEffect, useState } from 'react';
import type { ChatbotCommandSettings, DashboardStatus, LlmSettingsUpdate } from '../../shared/api';
import {
  getChatbotCommandSettings,
  getLlmSettings,
  updateChatbotCommandSettings,
  updateLlmSettings,
} from '../services/dashboard';

const EMPTY_COMMAND_SETTINGS: ChatbotCommandSettings = {
  enabled: true,
  command: '',
  response: '',
};

type LlmSettingsForm = LlmSettingsUpdate & {
  apiKeyConfigured: boolean;
};

const EMPTY_LLM_SETTINGS: LlmSettingsForm = {
  enabled: true,
  baseUrl: 'http://localhost:1234/v1',
  model: '',
  apiKey: '',
  clearApiKey: false,
  apiKeyConfigured: false,
  personalityPrompt: '',
  temperature: 0.7,
  maxOutputTokens: 140,
  timeoutMs: 15000,
};

function SettingsRow({
  label,
  sub,
  children,
}: {
  label: string;
  sub?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="set-row">
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="set-label">{label}</div>
        {sub && <div className="set-sub">{sub}</div>}
      </div>
      <div className="set-control">{children}</div>
    </div>
  );
}

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
  const [commandSettings, setCommandSettings] = useState<ChatbotCommandSettings>(EMPTY_COMMAND_SETTINGS);
  const [commandLoading, setCommandLoading] = useState(true);
  const [commandSaving, setCommandSaving] = useState(false);
  const [commandMessage, setCommandMessage] = useState<string | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [llmSettings, setLlmSettings] = useState<LlmSettingsForm>(EMPTY_LLM_SETTINGS);
  const [llmLoading, setLlmLoading] = useState(true);
  const [llmSaving, setLlmSaving] = useState(false);
  const [llmMessage, setLlmMessage] = useState<string | null>(null);
  const [llmError, setLlmError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setCommandLoading(true);
    void getChatbotCommandSettings()
      .then(settings => {
        if (!cancelled) {
          setCommandSettings({
            enabled: settings.enabled,
            command: settings.command,
            response: settings.response,
          });
          setCommandError(null);
        }
      })
      .catch(error => {
        if (!cancelled) setCommandError(error instanceof Error ? error.message : 'Could not load command settings');
      })
      .finally(() => {
        if (!cancelled) setCommandLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLlmLoading(true);
    void getLlmSettings()
      .then(settings => {
        if (!cancelled) {
          setLlmSettings({
            enabled: settings.enabled,
            baseUrl: settings.baseUrl,
            model: settings.model,
            apiKey: '',
            clearApiKey: false,
            apiKeyConfigured: settings.apiKeyConfigured,
            personalityPrompt: settings.personalityPrompt,
            temperature: settings.temperature,
            maxOutputTokens: settings.maxOutputTokens,
            timeoutMs: settings.timeoutMs,
          });
          setLlmError(null);
        }
      })
      .catch(error => {
        if (!cancelled) setLlmError(error instanceof Error ? error.message : 'Could not load LLM settings');
      })
      .finally(() => {
        if (!cancelled) setLlmLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const handleCommandSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setCommandSaving(true);
    setCommandMessage(null);
    setCommandError(null);
    void updateChatbotCommandSettings(commandSettings)
      .then(settings => {
        setCommandSettings({
          enabled: settings.enabled,
          command: settings.command,
          response: settings.response,
        });
        setCommandMessage(settings.command ? 'Saved' : 'Cleared');
      })
      .catch(error => {
        setCommandError(error instanceof Error ? error.message : 'Could not save command settings');
      })
      .finally(() => setCommandSaving(false));
  };

  const handleCommandClear = () => {
    setCommandSaving(true);
    setCommandMessage(null);
    setCommandError(null);
    void updateChatbotCommandSettings(EMPTY_COMMAND_SETTINGS)
      .then(settings => {
        setCommandSettings({
          enabled: settings.enabled,
          command: settings.command,
          response: settings.response,
        });
        setCommandMessage('Cleared');
      })
      .catch(error => {
        setCommandError(error instanceof Error ? error.message : 'Could not clear command settings');
      })
      .finally(() => setCommandSaving(false));
  };

  const handleLlmSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLlmSaving(true);
    setLlmMessage(null);
    setLlmError(null);
    void updateLlmSettings({
      enabled: llmSettings.enabled,
      baseUrl: llmSettings.baseUrl,
      model: llmSettings.model,
      apiKey: llmSettings.apiKey,
      clearApiKey: llmSettings.clearApiKey,
      personalityPrompt: llmSettings.personalityPrompt,
      temperature: llmSettings.temperature,
      maxOutputTokens: llmSettings.maxOutputTokens,
      timeoutMs: llmSettings.timeoutMs,
    })
      .then(settings => {
        setLlmSettings({
          enabled: settings.enabled,
          baseUrl: settings.baseUrl,
          model: settings.model,
          apiKey: '',
          clearApiKey: false,
          apiKeyConfigured: settings.apiKeyConfigured,
          personalityPrompt: settings.personalityPrompt,
          temperature: settings.temperature,
          maxOutputTokens: settings.maxOutputTokens,
          timeoutMs: settings.timeoutMs,
        });
        setLlmMessage('Saved');
      })
      .catch(error => {
        setLlmError(error instanceof Error ? error.message : 'Could not save LLM settings');
      })
      .finally(() => setLlmSaving(false));
  };

  return (
    <div className="settings-page">
      <div className="settings-inner">
        <div className="eyebrow" style={{ marginBottom: '6px' }}>settings</div>
        <h2 style={{ margin: '0 0 4px', fontFamily: 'var(--font-display)', fontSize: '28px', fontWeight: 500 }}>
          Control room
        </h2>
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
              <a className="btn-primary" href="/api/auth/twitch?force=1">Reconnect</a>
            ) : status.twitchAuthenticated && status.twitchAuthSource === 'oauth' ? (
              <button className="btn-primary" onClick={onTwitchLogout}>Disconnect</button>
            ) : status.twitchAuthenticated ? (
              <span className="set-badge set-badge--ok">Configured</span>
            ) : (
              <a className="btn-primary" href="/api/auth/twitch">
                Login with Twitch
              </a>
            )}
          </SettingsRow>
          <SettingsRow
            label="Bot login"
            sub={twitchBotLoginSub}
          >
            {missingTwitchBotScopes ? (
              <a className="btn-primary" href="/api/auth/twitch/bot?force=1">Reconnect bot</a>
            ) : status.twitchBotAuthenticated && status.twitchBotAuthSource === 'oauth' ? (
              <button className="btn-primary" onClick={onTwitchBotLogout}>Disconnect</button>
            ) : status.twitchBotAuthenticated ? (
              <span className="set-badge set-badge--ok">Configured</span>
            ) : (
              <a className="btn-primary" href="/api/auth/twitch/bot">
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

        <div className="set-group">
          <div className="set-group-label">Chat command reply</div>
          <form className="command-settings-form" onSubmit={handleCommandSubmit}>
            <label className="command-enabled">
              <input
                type="checkbox"
                checked={commandSettings.enabled}
                disabled={commandLoading || commandSaving}
                onChange={event => setCommandSettings(current => ({ ...current, enabled: event.target.checked }))}
              />
              <span>Enabled</span>
            </label>

            <label className="field">
              <span>Command</span>
              <input
                value={commandSettings.command}
                disabled={commandLoading || commandSaving}
                maxLength={50}
                placeholder="!site"
                onChange={event => setCommandSettings(current => ({ ...current, command: event.target.value }))}
              />
            </label>

            <label className="field">
              <span>Bot response</span>
              <textarea
                value={commandSettings.response}
                disabled={commandLoading || commandSaving}
                maxLength={500}
                rows={3}
                placeholder="@{username} https://example.com"
                onChange={event => setCommandSettings(current => ({ ...current, response: event.target.value }))}
              />
              <small>{commandSettings.response.length}/500</small>
            </label>

            <div className="command-example">
              Example: <code>@{'{username}'} https://example.com</code>
            </div>

            {(commandMessage || commandError) && (
              <div className={'command-settings-status' + (commandError ? ' error' : '')}>
                {commandError ?? commandMessage}
              </div>
            )}

            <div className="command-settings-actions">
              <button
                className="modbtn"
                type="button"
                disabled={commandLoading || commandSaving || (!commandSettings.command && !commandSettings.response)}
                onClick={handleCommandClear}
              >
                Clear
              </button>
              <button className="modbtn gold" type="submit" disabled={commandLoading || commandSaving}>
                {commandSaving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </form>
        </div>

        <div className="set-group">
          <div className="set-group-label">!ponder LLM</div>
          <form className="command-settings-form" onSubmit={handleLlmSubmit}>
            <label className="command-enabled">
              <input
                type="checkbox"
                checked={llmSettings.enabled}
                disabled={llmLoading || llmSaving}
                onChange={event => setLlmSettings(current => ({ ...current, enabled: event.target.checked }))}
              />
              <span>Enabled</span>
            </label>

            <label className="field">
              <span>Base URL</span>
              <input
                value={llmSettings.baseUrl}
                disabled={llmLoading || llmSaving}
                placeholder="http://localhost:1234/v1"
                onChange={event => setLlmSettings(current => ({ ...current, baseUrl: event.target.value }))}
              />
            </label>

            <label className="field">
              <span>Model</span>
              <input
                value={llmSettings.model}
                disabled={llmLoading || llmSaving}
                placeholder="Loaded LM Studio model identifier"
                onChange={event => setLlmSettings(current => ({ ...current, model: event.target.value }))}
              />
            </label>

            <label className="field">
              <span>API key</span>
              <input
                type="password"
                value={llmSettings.apiKey ?? ''}
                disabled={llmLoading || llmSaving || llmSettings.clearApiKey}
                placeholder={llmSettings.apiKeyConfigured ? 'Configured - leave blank to keep' : 'Optional for LM Studio'}
                onChange={event => setLlmSettings(current => ({ ...current, apiKey: event.target.value, clearApiKey: false }))}
              />
            </label>

            <label className="command-enabled">
              <input
                type="checkbox"
                checked={llmSettings.clearApiKey === true}
                disabled={llmLoading || llmSaving || !llmSettings.apiKeyConfigured}
                onChange={event => setLlmSettings(current => ({ ...current, clearApiKey: event.target.checked, apiKey: '' }))}
              />
              <span>Clear stored API key</span>
            </label>

            <label className="field">
              <span>Personality prompt</span>
              <textarea
                value={llmSettings.personalityPrompt}
                disabled={llmLoading || llmSaving}
                maxLength={2000}
                rows={5}
                placeholder="Be silly, lightly snarky, concise, and stream-chat friendly."
                onChange={event => setLlmSettings(current => ({ ...current, personalityPrompt: event.target.value }))}
              />
              <small>{llmSettings.personalityPrompt.length}/2000</small>
            </label>

            <div className="llm-settings-grid">
              <label className="field">
                <span>Temperature</span>
                <input
                  type="number"
                  min="0"
                  max="2"
                  step="0.1"
                  value={llmSettings.temperature}
                  disabled={llmLoading || llmSaving}
                  onChange={event => setLlmSettings(current => ({ ...current, temperature: Number(event.target.value) }))}
                />
              </label>

              <label className="field">
                <span>Max output tokens</span>
                <input
                  type="number"
                  min="32"
                  max="500"
                  step="1"
                  value={llmSettings.maxOutputTokens}
                  disabled={llmLoading || llmSaving}
                  onChange={event => setLlmSettings(current => ({ ...current, maxOutputTokens: Number(event.target.value) }))}
                />
              </label>

              <label className="field">
                <span>Timeout ms</span>
                <input
                  type="number"
                  min="1000"
                  max="60000"
                  step="500"
                  value={llmSettings.timeoutMs}
                  disabled={llmLoading || llmSaving}
                  onChange={event => setLlmSettings(current => ({ ...current, timeoutMs: Number(event.target.value) }))}
                />
              </label>
            </div>

            <div className="command-example">
              LM Studio default: <code>http://localhost:1234/v1</code>. Use <code>!ponder why is CSS like this?</code>
            </div>

            {(llmMessage || llmError) && (
              <div className={'command-settings-status' + (llmError ? ' error' : '')}>
                {llmError ?? llmMessage}
              </div>
            )}

            <div className="command-settings-actions">
              <button className="modbtn gold" type="submit" disabled={llmLoading || llmSaving}>
                {llmSaving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </form>
        </div>

        <p className="set-foot">
          More to come - alerts, hotkeys, OBS scenes.
        </p>
      </div>
    </div>
  );
}
