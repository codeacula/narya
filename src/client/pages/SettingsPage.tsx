import React, { useEffect, useState } from 'react';
import { Icon } from '../ui/icons';
import { useToast } from '../ui/notifications';
import type {
  AppConfig,
  ChatbotCommand,
  ChatbotCommandActionInput,
  ChatbotCommandActionType,
  DashboardStatus,
  DiscordChannel,
  DiscordGuild,
  DiscordStatus,
  GoLiveSettings,
  LlmSettingsUpdate,
  ObsStatus,
  RunItem,
  SoundButton,
  TickerItem,
  TtsSettings,
  TtsVoice,
} from '../../shared/api';
import { TTS_TONE_PRESETS } from '../../shared/tts';
import { withToken } from '../auth';
import {
  getAppConfig,
  updateAppConfig,
  clearDiscordGoLiveSettings,
  createRunsheetItem,
  createChatbotCommand,
  createSoundButton,
  createTickerItem,
  deleteRunsheetItem,
  deleteChatbotCommand,
  deleteSoundButton,
  deleteTickerItem,
  getChatbotCommands,
  getDiscordChannels,
  getDiscordGuilds,
  getDiscordStatus,
  refreshDiscordStatus,
  getGoLiveSettings,
  getLlmSettings,
  getObsStatus,
  getRunsheet,
  getSoundButtons,
  getTicker,
  getTtsSettings,
  getTtsStatus,
  getTtsVoices,
  testTtsSpeak,
  updateTtsSettings,
  updateRunsheetItem,
  updateChatbotCommand,
  updateGoLiveSettings,
  updateSoundButton,
  updateTickerItem,
  updateLlmSettings,
  testLlm,
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

type TtsStatus = {
  ok: boolean;
  baseUrl: string;
  error?: string;
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

type SoundForm = {
  id: string | null;
  label: string;
  filename: string;
};

type RunsheetForm = {
  id: string | null;
  text: string;
  done: boolean;
};

type TickerForm = {
  id: string | null;
  text: string;
};

type GoLiveSettingsForm = GoLiveSettings;

const EMPTY_COMMAND_FORM: CommandForm = {
  id: null,
  enabled: true,
  command: '',
  actionType: 'chat_reply',
  response: '',
  soundId: '',
  sceneName: '',
};

const EMPTY_SOUND_FORM: SoundForm = {
  id: null,
  label: '',
  filename: '',
};

const EMPTY_RUNSHEET_FORM: RunsheetForm = {
  id: null,
  text: '',
  done: false,
};

const EMPTY_TICKER_FORM: TickerForm = {
  id: null,
  text: '',
};

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
  maxOutputTokens: 2048,
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

function sortSoundButtons(items: SoundButton[]): SoundButton[] {
  return [...items].sort((a, b) => a.label.localeCompare(b.label));
}

function sortByPosition<T extends { position: number; text: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.position - b.position || a.text.localeCompare(b.text));
}

function formFromSound(sound: SoundButton): SoundForm {
  return {
    id: sound.id,
    label: sound.label,
    filename: sound.filename,
  };
}

function formFromRunsheet(item: RunItem): RunsheetForm {
  return {
    id: item.id,
    text: item.text,
    done: item.done,
  };
}

function formFromTicker(item: TickerItem): TickerForm {
  return {
    id: item.id,
    text: item.text,
  };
}

function SettingsRow({
  label,
  sub,
  children,
}: {
  label: React.ReactNode;
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
  const { pushToast } = useToast();
  const [appConfigForm, setAppConfigForm] = useState<AppConfigForm>(EMPTY_APP_CONFIG_FORM);
  const [appConfigLoading, setAppConfigLoading] = useState(true);
  const [appConfigSaving, setAppConfigSaving] = useState(false);
  const [appConfigMessage, setAppConfigMessage] = useState<string | null>(null);
  const [appConfigError, setAppConfigError] = useState<string | null>(null);
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
  const [llmTesting, setLlmTesting] = useState(false);
  const [llmTestQuestion, setLlmTestQuestion] = useState('why is CSS like this?');
  const [llmTestReply, setLlmTestReply] = useState<string | null>(null);
  const [llmMessage, setLlmMessage] = useState<string | null>(null);
  const [llmError, setLlmError] = useState<string | null>(null);
  const [runsheetItems, setRunsheetItems] = useState<RunItem[]>([]);
  const [tickerItems, setTickerItems] = useState<TickerItem[]>([]);
  const [soundForm, setSoundForm] = useState<SoundForm>(EMPTY_SOUND_FORM);
  const [runsheetForm, setRunsheetForm] = useState<RunsheetForm>(EMPTY_RUNSHEET_FORM);
  const [tickerForm, setTickerForm] = useState<TickerForm>(EMPTY_TICKER_FORM);
  const [contentLoading, setContentLoading] = useState(true);
  const [contentSaving, setContentSaving] = useState(false);
  const [contentMessage, setContentMessage] = useState<string | null>(null);
  const [contentError, setContentError] = useState<string | null>(null);
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
  const [ttsSettings, setTtsSettings] = useState<TtsSettings>({
    enabled: false,
    voiceProfileId: 'zombiechicken',
    languageId: 'en',
    tonePreset: 'neutral',
    exaggeration: 0.5,
    cfgWeight: 0.5,
    temperature: 0.8,
    volume: 0.8,
    updatedAt: null,
  });
  const [ttsVoices, setTtsVoices] = useState<TtsVoice[]>([]);
  const [ttsStatus, setTtsStatus] = useState<TtsStatus | null>(null);
  const [ttsLoading, setTtsLoading] = useState(true);
  const [ttsSaving, setTtsSaving] = useState(false);
  const [ttsTesting, setTtsTesting] = useState(false);
  const [ttsTestText, setTtsTestText] = useState('Hello, I am your stream assistant.');
  const [ttsMessage, setTtsMessage] = useState<string | null>(null);
  const [ttsError, setTtsError] = useState<string | null>(null);
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

  useEffect(() => {
    let cancelled = false;
    setCommandLoading(true);
    void Promise.all([
      getChatbotCommands(),
      getObsStatus().catch(() => null as ObsStatus | null),
    ])
      .then(([nextCommands, nextObsStatus]) => {
        if (!cancelled) {
          setCommands(nextCommands);
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
    setContentLoading(true);
    void Promise.all([getSoundButtons(), getRunsheet(), getTicker()])
      .then(([nextSoundButtons, nextRunsheetItems, nextTickerItems]) => {
        if (!cancelled) {
          setSoundButtons(sortSoundButtons(nextSoundButtons));
          setRunsheetItems(sortByPosition(nextRunsheetItems));
          setTickerItems(sortByPosition(nextTickerItems));
          setContentError(null);
        }
      })
      .catch(error => {
        if (!cancelled) setContentError(error instanceof Error ? error.message : 'Could not load stream content');
      })
      .finally(() => {
        if (!cancelled) setContentLoading(false);
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

  useEffect(() => {
    let cancelled = false;
    setTtsLoading(true);
    void Promise.all([
      getTtsSettings(),
      getTtsVoices().catch(() => [] as TtsVoice[]),
      getTtsStatus().catch(error => ({ ok: false, baseUrl: '', error: error instanceof Error ? error.message : 'Could not reach Chatterbox' })),
    ])
      .then(([settings, voices, status]) => {
        if (!cancelled) {
          setTtsSettings(settings);
          setTtsVoices(voices);
          setTtsStatus(status);
          setTtsError(null);
        }
      })
      .catch(error => {
        if (!cancelled) setTtsError(error instanceof Error ? error.message : 'Could not load TTS settings');
      })
      .finally(() => {
        if (!cancelled) setTtsLoading(false);
      });
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

  const handleSoundSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setContentSaving(true);
    setContentMessage(null);
    setContentError(null);
    const payload = { label: soundForm.label, filename: soundForm.filename };
    const request = soundForm.id ? updateSoundButton(soundForm.id, payload) : createSoundButton(payload);

    void request
      .then(saved => {
        setSoundButtons(current => sortSoundButtons([...current.filter(item => item.id !== saved.id), saved]));
        setSoundForm(formFromSound(saved));
        setContentMessage('Sound saved');
      })
      .catch(error => setContentError(error instanceof Error ? error.message : 'Could not save sound'))
      .finally(() => setContentSaving(false));
  };

  const handleSoundDelete = (id: string) => {
    const sound = soundButtons.find(item => item.id === id);
    if (!sound || !window.confirm(`Delete ${sound.label}?`)) return;
    setContentSaving(true);
    setContentMessage(null);
    setContentError(null);
    void deleteSoundButton(id)
      .then(() => {
        setSoundButtons(current => current.filter(item => item.id !== id));
        if (soundForm.id === id) setSoundForm(EMPTY_SOUND_FORM);
        setContentMessage('Sound deleted');
      })
      .catch(error => setContentError(error instanceof Error ? error.message : 'Could not delete sound'))
      .finally(() => setContentSaving(false));
  };

  const handleRunsheetSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setContentSaving(true);
    setContentMessage(null);
    setContentError(null);
    const payload = { text: runsheetForm.text, done: runsheetForm.done };
    const request = runsheetForm.id ? updateRunsheetItem(runsheetForm.id, payload) : createRunsheetItem(payload);

    void request
      .then(saved => {
        setRunsheetItems(current => sortByPosition([...current.filter(item => item.id !== saved.id), saved]));
        setRunsheetForm(formFromRunsheet(saved));
        setContentMessage('Runsheet saved');
      })
      .catch(error => setContentError(error instanceof Error ? error.message : 'Could not save runsheet item'))
      .finally(() => setContentSaving(false));
  };

  const handleRunsheetDelete = (id: string) => {
    const item = runsheetItems.find(row => row.id === id);
    if (!item || !window.confirm(`Delete "${item.text}"?`)) return;
    setContentSaving(true);
    setContentMessage(null);
    setContentError(null);
    void deleteRunsheetItem(id)
      .then(() => {
        setRunsheetItems(current => current.filter(row => row.id !== id));
        if (runsheetForm.id === id) setRunsheetForm(EMPTY_RUNSHEET_FORM);
        setContentMessage('Runsheet item deleted');
      })
      .catch(error => setContentError(error instanceof Error ? error.message : 'Could not delete runsheet item'))
      .finally(() => setContentSaving(false));
  };

  const handleTickerSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setContentSaving(true);
    setContentMessage(null);
    setContentError(null);
    const payload = { text: tickerForm.text };
    const request = tickerForm.id ? updateTickerItem(tickerForm.id, payload) : createTickerItem(payload);

    void request
      .then(saved => {
        setTickerItems(current => sortByPosition([...current.filter(item => item.id !== saved.id), saved]));
        setTickerForm(formFromTicker(saved));
        setContentMessage('Ticker saved');
      })
      .catch(error => setContentError(error instanceof Error ? error.message : 'Could not save ticker item'))
      .finally(() => setContentSaving(false));
  };

  const handleTickerDelete = (id: string) => {
    const item = tickerItems.find(row => row.id === id);
    if (!item || !window.confirm(`Delete "${item.text}"?`)) return;
    setContentSaving(true);
    setContentMessage(null);
    setContentError(null);
    void deleteTickerItem(id)
      .then(() => {
        setTickerItems(current => current.filter(row => row.id !== id));
        if (tickerForm.id === id) setTickerForm(EMPTY_TICKER_FORM);
        setContentMessage('Ticker item deleted');
      })
      .catch(error => setContentError(error instanceof Error ? error.message : 'Could not delete ticker item'))
      .finally(() => setContentSaving(false));
  };

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

  const handleLlmTest = () => {
    setLlmTesting(true);
    setLlmMessage(null);
    setLlmError(null);
    setLlmTestReply(null);
    void testLlm(llmTestQuestion)
      .then(result => {
        setLlmTestReply(result.reply);
      })
      .catch(error => {
        setLlmError(error instanceof Error ? error.message : 'Could not test LLM');
      })
      .finally(() => setLlmTesting(false));
  };

  const handleTtsSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setTtsSaving(true);
    setTtsMessage(null);
    setTtsError(null);
    void updateTtsSettings({
      enabled: ttsSettings.enabled,
      voiceProfileId: ttsSettings.voiceProfileId,
      languageId: ttsSettings.languageId,
      tonePreset: ttsSettings.tonePreset,
      exaggeration: ttsSettings.exaggeration,
      cfgWeight: ttsSettings.cfgWeight,
      temperature: ttsSettings.temperature,
      volume: ttsSettings.volume,
    })
      .then(saved => {
        setTtsSettings(saved);
        setTtsMessage('TTS settings saved.');
      })
      .catch(error => {
        setTtsError(error instanceof Error ? error.message : 'Could not save TTS settings');
      })
      .finally(() => setTtsSaving(false));
  };

  const handleTtsTest = () => {
    setTtsTesting(true);
    setTtsMessage(null);
    setTtsError(null);
    void testTtsSpeak(ttsTestText)
      .then(() => {
        setTtsMessage('Sent — check the /overlay/sounds browser source for audio.');
      })
      .catch(error => {
        setTtsError(error instanceof Error ? error.message : 'TTS test failed');
      })
      .finally(() => setTtsTesting(false));
  };

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
            && !status.eventSubConnected && (
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
                      <li><b>Docker / production:</b> <code>http://localhost:4317/api/auth/discord/callback</code></li>
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
          <div className="set-group-label">Tablet and overlay content</div>
          {(contentMessage || contentError) && (
            <div className={'command-settings-status settings-inline-status' + (contentError ? ' error' : '')}>
              {contentError ?? contentMessage}
            </div>
          )}

          <div className="settings-editor-section">
            <div className="command-editor-head">
              <div>
                <div className="set-label">Sound buttons</div>
                <div className="set-sub">Buttons available on the tablet and in bot command sound actions.</div>
              </div>
              <button
                className="modbtn"
                type="button"
                disabled={contentSaving}
                onClick={() => {
                  setSoundForm(EMPTY_SOUND_FORM);
                  setContentMessage(null);
                  setContentError(null);
                }}
              >
                New
              </button>
            </div>

            <div className="settings-mini-list">
              {contentLoading ? (
                <div className="command-empty">Loading sounds...</div>
              ) : soundButtons.length === 0 ? (
                <div className="command-empty">No sound buttons configured.</div>
              ) : soundButtons.map(sound => (
                <div className="settings-item-row" key={sound.id}>
                  <div className="settings-item-main">
                    <b>{sound.label}</b>
                    <span>{sound.filename}</span>
                  </div>
                  <div className="command-row-actions">
                    <button className="modbtn" type="button" disabled={contentSaving} onClick={() => setSoundForm(formFromSound(sound))}>
                      Edit
                    </button>
                    <button className="modbtn danger" type="button" disabled={contentSaving} onClick={() => handleSoundDelete(sound.id)}>
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <form className="settings-mini-form" onSubmit={handleSoundSubmit}>
              <label className="field">
                <span>Label</span>
                <input
                  value={soundForm.label}
                  disabled={contentLoading || contentSaving}
                  maxLength={60}
                  placeholder="Quack 1"
                  onChange={event => setSoundForm(current => ({ ...current, label: event.target.value }))}
                />
              </label>
              <label className="field">
                <span>File path</span>
                <input
                  value={soundForm.filename}
                  disabled={contentLoading || contentSaving}
                  maxLength={240}
                  placeholder="/sounds/quacks/duck-quack.mp3"
                  onChange={event => setSoundForm(current => ({ ...current, filename: event.target.value }))}
                />
              </label>
              <div className="command-settings-actions">
                <button className="modbtn gold" type="submit" disabled={contentLoading || contentSaving}>
                  {contentSaving ? 'Saving...' : 'Save Sound'}
                </button>
              </div>
            </form>
          </div>

          <div className="settings-editor-section">
            <div className="command-editor-head">
              <div>
                <div className="set-label">Runsheet</div>
                <div className="set-sub">Checklist items for stream preparation and live reminders.</div>
              </div>
              <button
                className="modbtn"
                type="button"
                disabled={contentSaving}
                onClick={() => {
                  setRunsheetForm(EMPTY_RUNSHEET_FORM);
                  setContentMessage(null);
                  setContentError(null);
                }}
              >
                New
              </button>
            </div>

            <div className="settings-mini-list">
              {contentLoading ? (
                <div className="command-empty">Loading runsheet...</div>
              ) : runsheetItems.length === 0 ? (
                <div className="command-empty">No runsheet items configured.</div>
              ) : runsheetItems.map(item => (
                <div className="settings-item-row" key={item.id}>
                  <div className="settings-item-main">
                    <b>{item.text}</b>
                    <span>{item.done ? 'Done' : 'Open'}</span>
                  </div>
                  <div className="command-row-actions">
                    <button className="modbtn" type="button" disabled={contentSaving} onClick={() => setRunsheetForm(formFromRunsheet(item))}>
                      Edit
                    </button>
                    <button className="modbtn danger" type="button" disabled={contentSaving} onClick={() => handleRunsheetDelete(item.id)}>
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <form className="settings-mini-form" onSubmit={handleRunsheetSubmit}>
              <label className="field settings-wide-field">
                <span>Item</span>
                <input
                  value={runsheetForm.text}
                  disabled={contentLoading || contentSaving}
                  maxLength={240}
                  placeholder="Check scenes and audio"
                  onChange={event => setRunsheetForm(current => ({ ...current, text: event.target.value }))}
                />
              </label>
              <label className="command-enabled settings-checkbox-field">
                <input
                  type="checkbox"
                  checked={runsheetForm.done}
                  disabled={contentLoading || contentSaving}
                  onChange={event => setRunsheetForm(current => ({ ...current, done: event.target.checked }))}
                />
                <span>Done</span>
              </label>
              <div className="command-settings-actions">
                <button className="modbtn gold" type="submit" disabled={contentLoading || contentSaving}>
                  {contentSaving ? 'Saving...' : 'Save Item'}
                </button>
              </div>
            </form>
          </div>

          <div className="settings-editor-section">
            <div className="command-editor-head">
              <div>
                <div className="set-label">Ticker</div>
                <div className="set-sub">Short text items for overlay or dashboard ticker surfaces.</div>
              </div>
              <button
                className="modbtn"
                type="button"
                disabled={contentSaving}
                onClick={() => {
                  setTickerForm(EMPTY_TICKER_FORM);
                  setContentMessage(null);
                  setContentError(null);
                }}
              >
                New
              </button>
            </div>

            <div className="settings-mini-list">
              {contentLoading ? (
                <div className="command-empty">Loading ticker...</div>
              ) : tickerItems.length === 0 ? (
                <div className="command-empty">No ticker items configured.</div>
              ) : tickerItems.map(item => (
                <div className="settings-item-row" key={item.id}>
                  <div className="settings-item-main">
                    <b>{item.text}</b>
                  </div>
                  <div className="command-row-actions">
                    <button className="modbtn" type="button" disabled={contentSaving} onClick={() => setTickerForm(formFromTicker(item))}>
                      Edit
                    </button>
                    <button className="modbtn danger" type="button" disabled={contentSaving} onClick={() => handleTickerDelete(item.id)}>
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <form className="settings-mini-form" onSubmit={handleTickerSubmit}>
              <label className="field settings-wide-field">
                <span>Text</span>
                <input
                  value={tickerForm.text}
                  disabled={contentLoading || contentSaving}
                  maxLength={160}
                  placeholder="Follow for more local nonsense"
                  onChange={event => setTickerForm(current => ({ ...current, text: event.target.value }))}
                />
              </label>
              <div className="command-settings-actions">
                <button className="modbtn gold" type="submit" disabled={contentLoading || contentSaving}>
                  {contentSaving ? 'Saving...' : 'Save Ticker'}
                </button>
              </div>
            </form>
          </div>
        </div>

        <div className="set-group">
          <div className="set-group-label">Text-to-Speech</div>
          <form className="command-settings-form" onSubmit={handleTtsSubmit}>
            <label className="command-enabled">
              <input
                type="checkbox"
                checked={ttsSettings.enabled}
                disabled={ttsLoading || ttsSaving}
                onChange={event => setTtsSettings(current => ({ ...current, enabled: event.target.checked }))}
              />
              <span>Enabled</span>
            </label>

            {ttsStatus && (
              <div className={'settings-alert ' + (ttsStatus.ok ? 'settings-alert--info' : 'settings-alert--warn')}>
                <span className="settings-alert-icon">{ttsStatus.ok ? 'i' : '!'}</span>
                <span>
                  Chatterbox service {ttsStatus.ok ? 'connected' : 'unavailable'}
                  {ttsStatus.baseUrl ? ` at ${ttsStatus.baseUrl}` : ''}
                  {!ttsStatus.ok && ttsStatus.error ? `: ${ttsStatus.error}` : ''}
                </span>
              </div>
            )}

            <label className="field">
              <span>Voice profile</span>
              <select
                value={ttsSettings.voiceProfileId}
                disabled={ttsLoading || ttsSaving || ttsVoices.length === 0}
                onChange={event => setTtsSettings(current => ({ ...current, voiceProfileId: event.target.value }))}
              >
                {ttsVoices.map(voice => (
                  <option key={voice.id} value={voice.id}>{voice.name} ({voice.category})</option>
                ))}
              </select>
            </label>

            <div className="llm-settings-grid">
              <label className="field">
                <span>Language</span>
                <input
                  value={ttsSettings.languageId}
                  disabled={ttsLoading || ttsSaving}
                  maxLength={12}
                  onChange={event => setTtsSettings(current => ({ ...current, languageId: event.target.value }))}
                />
              </label>

              <label className="field">
                <span>Tone preset</span>
                <select
                  value={ttsSettings.tonePreset}
                  disabled={ttsLoading || ttsSaving}
                  onChange={event => {
                    const tonePreset = event.target.value as keyof typeof TTS_TONE_PRESETS;
                    const preset = TTS_TONE_PRESETS[tonePreset] ?? TTS_TONE_PRESETS.neutral;
                    setTtsSettings(current => ({ ...current, tonePreset, ...preset }));
                  }}
                >
                  <option value="neutral">Neutral</option>
                  <option value="calm">Calm</option>
                  <option value="expressive">Expressive</option>
                  <option value="dramatic">Dramatic</option>
                </select>
              </label>
            </div>

            <div className="llm-settings-grid">
              <label className="field">
                <span>Exaggeration</span>
                <input
                  type="number"
                  min="0"
                  max="1"
                  step="0.05"
                  value={ttsSettings.exaggeration}
                  disabled={ttsLoading || ttsSaving}
                  onChange={event => setTtsSettings(current => ({ ...current, exaggeration: Number(event.target.value) }))}
                />
              </label>

              <label className="field">
                <span>CFG weight</span>
                <input
                  type="number"
                  min="0"
                  max="1"
                  step="0.05"
                  value={ttsSettings.cfgWeight}
                  disabled={ttsLoading || ttsSaving}
                  onChange={event => setTtsSettings(current => ({ ...current, cfgWeight: Number(event.target.value) }))}
                />
              </label>
            </div>

            <div className="llm-settings-grid">
              <label className="field">
                <span>Temperature</span>
                <input
                  type="number"
                  min="0.05"
                  max="1.5"
                  step="0.05"
                  value={ttsSettings.temperature}
                  disabled={ttsLoading || ttsSaving}
                  onChange={event => setTtsSettings(current => ({ ...current, temperature: Number(event.target.value) }))}
                />
              </label>

              <label className="field">
                <span>Volume</span>
                <input
                  type="number"
                  min="0"
                  max="1"
                  step="0.05"
                  value={ttsSettings.volume}
                  disabled={ttsLoading || ttsSaving}
                  onChange={event => setTtsSettings(current => ({ ...current, volume: Number(event.target.value) }))}
                />
              </label>
            </div>

            <div className="command-example">
              Triggered via <code>!tts &lt;text&gt;</code> (broadcaster/mod/VIP) or per channel point reward. Audio plays through the <code>/overlay/sounds</code> browser source using the Chatterbox service.
            </div>

            <div className="llm-test-panel">
              <label className="field">
                <span>Test phrase</span>
                <input
                  value={ttsTestText}
                  disabled={ttsLoading || ttsSaving || ttsTesting}
                  maxLength={500}
                  onChange={event => setTtsTestText(event.target.value)}
                />
              </label>
              <div className="command-settings-actions">
                <button
                  className="modbtn"
                  type="button"
                  disabled={ttsLoading || ttsSaving || ttsTesting || !ttsSettings.enabled}
                  onClick={handleTtsTest}
                >
                  {ttsTesting ? 'Sending...' : 'Test TTS'}
                </button>
              </div>
            </div>

            {(ttsMessage || ttsError) && (
              <div className={'command-settings-status' + (ttsError ? ' error' : '')}>
                {ttsError ?? ttsMessage}
              </div>
            )}

            <div className="command-settings-actions">
              <button className="modbtn gold" type="submit" disabled={ttsLoading || ttsSaving}>
                {ttsSaving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </form>
        </div>

        <div className="set-group">
          <div className="set-group-label">LLM settings</div>
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
                <span>Max output tokens (0 = unlimited)</span>
                <input
                  type="number"
                  min="0"
                  max="8192"
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

            <div className="llm-test-panel">
              <label className="field">
                <span>Test question</span>
                <input
                  value={llmTestQuestion}
                  disabled={llmLoading || llmSaving || llmTesting}
                  maxLength={500}
                  onChange={event => setLlmTestQuestion(event.target.value)}
                />
              </label>
              <div className="command-settings-actions">
                <button
                  className="modbtn"
                  type="button"
                  disabled={llmLoading || llmSaving || llmTesting}
                  onClick={handleLlmTest}
                >
                  {llmTesting ? 'Testing...' : 'Test LLM'}
                </button>
              </div>
              {llmTestReply && <div className="llm-test-reply">{llmTestReply}</div>}
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
