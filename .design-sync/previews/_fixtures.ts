// Shared preview fixtures.
//
// Only `Chat` and `Spotlight` actually take `PanelCtx`. The other panels take
// flat props and are listed here so nobody re-derives this the hard way:
//   ChattersPanel  { chatters, viewers, error, onOpenViewer }
//   AttentionPanel { items, acked, settings, onAck, onSettingsChange }
//   ShoutoutsPanel { shoutouts, streamActive, onOpenViewer }
//   ControlsPanel  { status, scenes, scenePrefix, currentScene, … }
// The shared data below (VIEWERS, CHAT, EVENTS, CHATTERS, …) is reused across
// all of them regardless of how each one takes it.
//
// Underscore prefix keeps this out of the converter's <Name>.tsx preview
// discovery — it is a helper module, not a component preview.
import type { Chatter, ChatEntry, DashboardStatus, StreamEvent, Viewer } from '../../src/shared/api';
import type { PanelCtx } from '../../src/client/ui/panels';
import type { AttentionItem, AttentionSettings } from '../../src/client/attention';

export const CHANNEL = 'codeacula';
export const SESSION = 'sess-2026-07-19';

/**
 * Ages are rendered by `formatAgo`, so a fixed instant reads as a nonsense
 * duration the day after it was written. Always compute from `Date.now()`.
 */
export const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

function viewer(login: string, over: Partial<Viewer> = {}): Viewer {
  return {
    login,
    display: login,
    color: '#ffb86c',
    realName: '',
    tags: [],
    roles: [],
    followed: '2025-11-02',
    subbed: '',
    seen: '2 minutes ago',
    msgs: 12,
    accountAge: '3 years',
    note: '',
    recent: [],
    ...over,
  };
}

export const VIEWERS: Record<string, Viewer> = {
  codeacula: viewer('codeacula', {
    display: 'Codeacula',
    roles: ['broadcaster'],
    msgs: 481,
    seen: 'just now',
    realName: 'Cody',
    tags: ['host'],
  }),
  lanternkeeper: viewer('lanternkeeper', {
    display: 'LanternKeeper',
    color: '#9e82e8',
    roles: ['mod', 'sub'],
    msgs: 1204,
    subbed: '14 months',
    tags: ['regular', 'night owl'],
    note: 'Runs the Sunday co-stream.',
    // Spotlight's "Recent in chat" section is driven entirely by `recent` — an
    // empty array renders the panel as a header with a blank block under it.
    recent: [
      { t: 'ship it', ago: '1m' },
      { t: 'the new overlay bounds toggle is doing exactly what we wanted', ago: '3m' },
      { t: 'chat go follow codeacula while the build runs', ago: '11m' },
      { t: 'raid incoming, be nice to the new folks', ago: '16m', kind: 'mod' },
    ],
  }),
  emberwright: viewer('emberwright', {
    display: 'Emberwright',
    color: '#a2aabc',
    roles: ['vip'],
    msgs: 87,
    seen: '6 minutes ago',
    subbed: '3 months',
    recent: [
      { t: 'wait you can drag the popouts now?', ago: '2m' },
      { t: 'cheer500 that refactor was worth every minute', ago: '22m' },
    ],
  }),
  quietmoth: viewer('quietmoth', {
    display: 'quietmoth',
    color: '#7b85a0',
    roles: [],
    msgs: 1,
    accountAge: '2 days',
    seen: 'just now',
    recent: [{ t: 'first time catching a stream live — hi!', ago: '4m' }],
  }),
};

export const CHAT: ChatEntry[] = [
  {
    id: 'm1',
    user: 'LanternKeeper',
    text: 'the new overlay bounds toggle is doing exactly what we wanted',
    time: '7:12',
    at: '2026-07-19T19:12:04Z',
    sessionId: SESSION,
    highlight: 'mod',
  },
  {
    id: 'm2',
    user: 'Emberwright',
    text: 'wait you can drag the popouts now?',
    time: '7:12',
    at: '2026-07-19T19:12:41Z',
    sessionId: SESSION,
    highlight: 'vip',
  },
  {
    id: 'm3',
    user: 'quietmoth',
    text: 'first time catching a stream live — hi!',
    time: '7:13',
    at: '2026-07-19T19:13:02Z',
    sessionId: SESSION,
    highlight: 'first-ever',
  },
  {
    id: 'm4',
    user: 'Codeacula',
    text: 'welcome in! grab a seat, we are mid-refactor',
    time: '7:13',
    at: '2026-07-19T19:13:20Z',
    sessionId: SESSION,
    highlight: 'broadcaster',
  },
  {
    id: 'm5',
    user: 'LanternKeeper',
    text: 'ship it',
    time: '7:14',
    at: '2026-07-19T19:14:09Z',
    sessionId: SESSION,
    highlight: 'mod',
  },
];

export const EVENTS: StreamEvent[] = [
  {
    id: 'e1',
    kind: 'follow',
    actor: 'quietmoth',
    detail: '',
    ago: '1m',
    tone: '',
    receivedAt: '2026-07-19T19:13:40Z',
    sessionId: SESSION,
  },
  {
    id: 'e2',
    kind: 'sub',
    actor: 'Emberwright',
    detail: 'Tier 1 · 3 months',
    ago: '4m',
    tone: '',
    receivedAt: '2026-07-19T19:10:11Z',
    sessionId: SESSION,
  },
  {
    id: 'e3',
    kind: 'raid',
    actor: 'LanternKeeper',
    detail: '42 viewers',
    ago: '16m',
    tone: '',
    receivedAt: '2026-07-19T18:58:02Z',
    sessionId: SESSION,
  },
  {
    id: 'e4',
    kind: 'cheer',
    actor: 'Emberwright',
    detail: '500 bits',
    ago: '22m',
    tone: '',
    receivedAt: '2026-07-19T18:52:30Z',
    sessionId: SESSION,
  },
];

// OBS names its switch targets with the operator's configured prefix; the numeric
// segment forces list order in OBS and is stripped from the button label.
export const SCENE_PREFIX = 'Scene - ';

export const OBS_SCENES: string[] = [
  'Scene - 01 - Starting Soon',
  'Scene - 02 - Desktop',
  'Scene - 03 - Camera',
  'Scene - 04 - Pair Programming',
  'Scene - 05 - Break',
  'Scene - 06 - Ending',
  // Not switch targets: no prefix, so switchableScenes filters them out.
  'Nested - Alerts',
  'Nested - Music',
];

/**
 * A live-stream DashboardStatus. ControlsPanel reads only `obsConnected`, but the
 * whole record is required by the contract — override the one field per variant.
 */
export const STATUS: DashboardStatus = {
  channel: CHANNEL,
  chatConnection: 'OPEN',
  obsConnected: true,
  eventSubConnected: true,
  eventSubError: null,
  eventSubFailedSubscriptions: [],
  twitchAuthenticated: true,
  twitchAuthSource: 'oauth',
  twitchTokenExpiresAt: null,
  twitchMissingScopes: [],
  twitchBotAuthenticated: true,
  twitchBotAuthSource: 'oauth',
  twitchBotTokenExpiresAt: null,
  twitchBotMissingScopes: [],
  streamActive: true,
  uptimeSeconds: 4 * 3600 + 12 * 60,
  streamStartedAt: null,
  uptimeSource: 'twitch',
  viewerCount: 342,
  activeChatters: 28,
  sessionChatters: 96,
  knownChatters: 1840,
  streamSessionId: SESSION,
  streamSessionStartedAt: null,
  bitrateKbps: 6000,
  congestion: 0.02,
  totalFrames: 620_400,
  droppedFrames: 12,
  laggedFrames: 3,
  adBreakEndsAt: null,
  adScheduleStatus: 'available',
  adScheduleError: null,
  nextAdAt: null,
  lastAdAt: null,
  adBreakDurationSeconds: 90,
  prerollFreeTimeSeconds: 120,
  snoozeCount: 2,
  snoozeRefreshAt: null,
};

/**
 * Twitch's Get Chatters presence list. `ChattersPanel` takes this directly
 * rather than the ctx — it colours and badges each row by looking the login up
 * in `VIEWERS`, so logins outside that map render plain, which is the real
 * behaviour for a lurker whose profile has not been backfilled yet.
 */
export const CHATTERS: Chatter[] = [
  { userId: '1', userLogin: 'codeacula', userName: 'Codeacula' },
  { userId: '2', userLogin: 'lanternkeeper', userName: 'LanternKeeper' },
  { userId: '3', userLogin: 'emberwright', userName: 'Emberwright' },
  { userId: '4', userLogin: 'quietmoth', userName: 'quietmoth' },
  { userId: '5', userLogin: 'saltglass', userName: 'saltglass' },
  { userId: '6', userLogin: 'northwindow', userName: 'NorthWindow' },
  { userId: '7', userLogin: 'ferrymarsh', userName: 'ferrymarsh' },
  { userId: '8', userLogin: 'oakenmire', userName: 'Oakenmire' },
];

/**
 * What `projectAttentionItems` produces from this session's thank-worthy events
 * plus chat from viewers carrying the attention tag. Built literally rather than
 * by calling the projector so the preview stays a pure render.
 */
export const ATTENTION_ITEMS: AttentionItem[] = [
  { id: 'e1', source: 'event', kind: 'follow', actor: 'quietmoth', detail: 'followed', at: minutesAgo(1) },
  { id: 'a1', source: 'chat', kind: 'chat', actor: 'LanternKeeper', detail: 'ship it', at: minutesAgo(3) },
  { id: 'e2', source: 'event', kind: 'sub', actor: 'Emberwright', detail: 'Tier 1 · 3 months', at: minutesAgo(6) },
  { id: 'e5', source: 'event', kind: 'gift', actor: 'NorthWindow', detail: '5 gift subs', at: minutesAgo(12) },
  { id: 'e3', source: 'event', kind: 'raid', actor: 'LanternKeeper', detail: '42 viewers', at: minutesAgo(16) },
  { id: 'e4', source: 'event', kind: 'cheer', actor: 'Emberwright', detail: '500 bits', at: minutesAgo(22) },
];

export const ATTENTION_SETTINGS: AttentionSettings = {
  tag: 'notify',
  soundEnabled: true,
  mentionSoundEnabled: true,
};

export const CTX: PanelCtx = {
  viewers: VIEWERS,
  chat: CHAT,
  events: EVENTS,
  channel: CHANNEL,
  currentSessionId: SESSION,
  openViewerPopout: () => undefined,
  updateViewerProfile: async () => ({ realName: '', tags: [], note: '' }),
  loadOlderChat: async () => false,
};
