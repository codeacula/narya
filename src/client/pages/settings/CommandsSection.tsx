import React, { useEffect, useState } from 'react';
import type {
  ChatbotCommand,
  ChatbotCommandActionInput,
  ChatbotCommandActionType,
  ObsStatus,
  SoundButton,
} from '../../../shared/api';
import {
  createChatbotCommand,
  deleteChatbotCommand,
  getChatbotCommands,
  getObsStatus,
  getSoundButtons,
  updateChatbotCommand,
} from '../../services/dashboard';

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

export function CommandsSection() {
  const [commands, setCommands] = useState<ChatbotCommand[]>([]);
  const [commandForm, setCommandForm] = useState<CommandForm>(EMPTY_COMMAND_FORM);
  const [soundButtons, setSoundButtons] = useState<SoundButton[]>([]);
  const [obsScenes, setObsScenes] = useState<string[]>([]);
  const [commandLoading, setCommandLoading] = useState(true);
  const [commandSaving, setCommandSaving] = useState(false);
  const [commandMessage, setCommandMessage] = useState<string | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setCommandLoading(true);
    void Promise.all([
      getChatbotCommands(),
      getObsStatus().catch(() => null as ObsStatus | null),
      getSoundButtons().catch(() => [] as SoundButton[]),
    ])
      .then(([nextCommands, nextObsStatus, nextSoundButtons]) => {
        if (!cancelled) {
          setCommands(nextCommands);
          setObsScenes(nextObsStatus?.scenes ?? []);
          setSoundButtons([...nextSoundButtons].sort((a, b) => a.label.localeCompare(b.label)));
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

  return (
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
  );
}
