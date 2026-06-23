import React, { useEffect, useState } from 'react';
import type {
  ChatbotCommand,
  ChatbotCommandActionInput,
  ChatbotCommandActionType,
  DashboardStatus,
  LlmSettingsUpdate,
  ObsStatus,
  SoundButton,
} from '../../shared/api';
import {
  createChatbotCommand,
  deleteChatbotCommand,
  getChatbotCommands,
  getLlmSettings,
  getObsStatus,
  getSoundButtons,
  updateChatbotCommand,
  updateLlmSettings,
} from '../services/dashboard';

type CommandForm = {
  id: string | null;
  enabled: boolean;
  command: string;
  actionType: ChatbotCommandActionType;
  response: string;
  soundId: string;
  sceneName: string;
};

const EMPTY_COMMAND_FORM: CommandForm = {
  id: null,
  enabled: true,
  command: '',
  actionType: 'chat_reply',
  response: '',
  soundId: '',
  sceneName: '',
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

function actionLabel(type: ChatbotCommandActionType): string {
  if (type === 'chat_reply') return 'Chat reply';
  if (type === 'llm_response') return 'LLM reply';
  if (type === 'sound_play') return 'Play sound';
  if (type === 'obs_scene') return 'OBS scene';
  return 'OBS transition';
}

function actionSummary(command: ChatbotCommand): string {
  const enabledActions = command.actions.filter(action => action.enabled);
  if (enabledActions.length === 0) return 'No enabled actions';
  return enabledActions.map(action => {
    if (action.type === 'chat_reply') return `Reply: ${action.payload.template ?? ''}`;
    if (action.type === 'llm_response') return 'LLM reply';
    if (action.type === 'sound_play') return `Sound: ${action.payload.soundId ?? ''}`;
    if (action.type === 'obs_scene') return `Scene: ${action.payload.sceneName ?? ''}`;
    return 'OBS transition';
  }).join(', ');
}

function formFromCommand(command: ChatbotCommand): CommandForm {
  const action = command.actions[0];
  return {
    id: command.id,
    enabled: command.enabled,
    command: command.command,
    actionType: action?.type ?? 'chat_reply',
    response: action?.payload.template ?? '',
    soundId: action?.payload.soundId ?? '',
    sceneName: action?.payload.sceneName ?? '',
  };
}

function commandActionsFromForm(form: CommandForm): ChatbotCommandActionInput[] {
  if (form.actionType === 'chat_reply') {
    return [{ type: 'chat_reply', enabled: true, payload: { template: form.response } }];
  }
  if (form.actionType === 'sound_play') {
    return [{ type: 'sound_play', enabled: true, payload: { soundId: form.soundId } }];
  }
  if (form.actionType === 'obs_scene') {
    return [{ type: 'obs_scene', enabled: true, payload: { sceneName: form.sceneName } }];
  }
  return [{ type: form.actionType, enabled: true, payload: {} }];
}

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
  const [commands, setCommands] = useState<ChatbotCommand[]>([]);
  const [commandForm, setCommandForm] = useState<CommandForm>(EMPTY_COMMAND_FORM);
  const [soundButtons, setSoundButtons] = useState<SoundButton[]>([]);
  const [obsScenes, setObsScenes] = useState<string[]>([]);
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
    void Promise.all([
      getChatbotCommands(),
      getSoundButtons().catch(() => [] as SoundButton[]),
      getObsStatus().catch(() => null as ObsStatus | null),
    ])
      .then(([nextCommands, nextSoundButtons, nextObsStatus]) => {
        if (!cancelled) {
          setCommands(nextCommands);
          setSoundButtons(nextSoundButtons);
          setObsScenes(nextObsStatus?.scenes ?? []);
          setCommandError(null);
        }
      })
      .catch(error => {
        if (!cancelled) setCommandError(error instanceof Error ? error.message : 'Could not load commands');
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
    const payload = {
      enabled: commandForm.enabled,
      command: commandForm.command,
      actions: commandActionsFromForm(commandForm),
    };
    const request = commandForm.id
      ? updateChatbotCommand(commandForm.id, payload)
      : createChatbotCommand(payload);

    void request
      .then(saved => {
        setCommands(current => {
          const withoutSaved = current.filter(command => command.id !== saved.id);
          return [...withoutSaved, saved].sort((a, b) => a.command.localeCompare(b.command));
        });
        setCommandForm(formFromCommand(saved));
        setCommandMessage('Saved');
      })
      .catch(error => {
        setCommandError(error instanceof Error ? error.message : 'Could not save command');
      })
      .finally(() => setCommandSaving(false));
  };

  const handleCommandDelete = (id: string) => {
    const command = commands.find(item => item.id === id);
    if (!command || !window.confirm(`Delete ${command.command}?`)) return;
    setCommandSaving(true);
    setCommandMessage(null);
    setCommandError(null);
    void deleteChatbotCommand(id)
      .then(() => {
        setCommands(current => current.filter(item => item.id !== id));
        if (commandForm.id === id) setCommandForm(EMPTY_COMMAND_FORM);
        setCommandMessage('Deleted');
      })
      .catch(error => {
        setCommandError(error instanceof Error ? error.message : 'Could not delete command');
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
          <div className="set-group-label">Bot commands</div>
          <div className="command-list">
            {commandLoading ? (
              <div className="command-empty">Loading commands...</div>
            ) : commands.length === 0 ? (
              <div className="command-empty">No commands configured.</div>
            ) : commands.map(command => (
              <div className="command-row" key={command.id}>
                <div className="command-row-main">
                  <div>
                    <span className="command-trigger">{command.command}</span>
                    <span className={'set-badge ' + (command.enabled ? 'set-badge--ok' : '')}>
                      {command.enabled ? 'Enabled' : 'Off'}
                    </span>
                  </div>
                  <div className="command-action-summary">{actionSummary(command)}</div>
                </div>
                <div className="command-row-actions">
                  <button
                    className="modbtn"
                    type="button"
                    disabled={commandSaving}
                    onClick={() => {
                      setCommandForm(formFromCommand(command));
                      setCommandMessage(null);
                      setCommandError(null);
                    }}
                  >
                    Edit
                  </button>
                  <button
                    className="modbtn danger"
                    type="button"
                    disabled={commandSaving}
                    onClick={() => handleCommandDelete(command.id)}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>

          <form className="command-settings-form" onSubmit={handleCommandSubmit}>
            <div className="command-editor-head">
              <div className="set-label">{commandForm.id ? 'Edit command' : 'New command'}</div>
              <button
                className="modbtn"
                type="button"
                disabled={commandSaving}
                onClick={() => {
                  setCommandForm(EMPTY_COMMAND_FORM);
                  setCommandMessage(null);
                  setCommandError(null);
                }}
              >
                New
              </button>
            </div>

            <label className="command-enabled">
              <input
                type="checkbox"
                checked={commandForm.enabled}
                disabled={commandLoading || commandSaving}
                onChange={event => setCommandForm(current => ({ ...current, enabled: event.target.checked }))}
              />
              <span>Enabled</span>
            </label>

            <label className="field">
              <span>Command</span>
              <input
                value={commandForm.command}
                disabled={commandLoading || commandSaving}
                maxLength={50}
                placeholder="!site"
                onChange={event => setCommandForm(current => ({ ...current, command: event.target.value }))}
              />
            </label>

            <label className="field">
              <span>Action</span>
              <select
                value={commandForm.actionType}
                disabled={commandLoading || commandSaving}
                onChange={event => setCommandForm(current => ({
                  ...current,
                  actionType: event.target.value as ChatbotCommandActionType,
                }))}
              >
                <option value="chat_reply">{actionLabel('chat_reply')}</option>
                <option value="llm_response">{actionLabel('llm_response')}</option>
                <option value="sound_play">{actionLabel('sound_play')}</option>
                <option value="obs_scene">{actionLabel('obs_scene')}</option>
                <option value="obs_transition">{actionLabel('obs_transition')}</option>
              </select>
            </label>

            {commandForm.actionType === 'chat_reply' && (
              <label className="field">
                <span>Bot response</span>
                <textarea
                  value={commandForm.response}
                  disabled={commandLoading || commandSaving}
                  maxLength={500}
                  rows={3}
                  placeholder="@{username} https://example.com"
                  onChange={event => setCommandForm(current => ({ ...current, response: event.target.value }))}
                />
                <small>{commandForm.response.length}/500</small>
              </label>
            )}

            {commandForm.actionType === 'sound_play' && (
              <label className="field">
                <span>Sound</span>
                <select
                  value={commandForm.soundId}
                  disabled={commandLoading || commandSaving || soundButtons.length === 0}
                  onChange={event => setCommandForm(current => ({ ...current, soundId: event.target.value }))}
                >
                  <option value="">Select a sound</option>
                  {soundButtons.map(sound => (
                    <option value={sound.id} key={sound.id}>{sound.label}</option>
                  ))}
                </select>
              </label>
            )}

            {commandForm.actionType === 'obs_scene' && (
              <label className="field">
                <span>Scene</span>
                {obsScenes.length > 0 ? (
                  <select
                    value={commandForm.sceneName}
                    disabled={commandLoading || commandSaving}
                    onChange={event => setCommandForm(current => ({ ...current, sceneName: event.target.value }))}
                  >
                    <option value="">Select a scene</option>
                    {obsScenes.map(scene => (
                      <option value={scene} key={scene}>{scene}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    value={commandForm.sceneName}
                    disabled={commandLoading || commandSaving}
                    placeholder="Scene name"
                    onChange={event => setCommandForm(current => ({ ...current, sceneName: event.target.value }))}
                  />
                )}
              </label>
            )}

            {commandForm.actionType === 'llm_response' && (
              <div className="command-example">
                Uses the prompt and connection below. Chat text after the command becomes the question.
              </div>
            )}

            {commandForm.actionType === 'obs_transition' && (
              <div className="command-example">
                Triggers the current OBS studio-mode transition.
              </div>
            )}

            {(commandMessage || commandError) && (
              <div className={'command-settings-status' + (commandError ? ' error' : '')}>
                {commandError ?? commandMessage}
              </div>
            )}

            <div className="command-settings-actions">
              <button className="modbtn gold" type="submit" disabled={commandLoading || commandSaving}>
                {commandSaving ? 'Saving...' : 'Save Command'}
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
