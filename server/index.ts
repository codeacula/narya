import { Database } from 'bun:sqlite';
import express from 'express';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import OBSWebSocket from 'obs-websocket-js';
import tmi from 'tmi.js';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';

const execFileAsync = promisify(execFile);

type ChatMessage = {
  id: string;
  channel: string;
  username: string;
  displayName: string;
  color: string | null;
  message: string;
  receivedAt: string;
  deletedAt: string | null;
  deletedReason: string | null;
  badges: Record<string, string> | null;
  emotes: Record<string, string[]> | null;
  isFirstTimer: boolean;
};

type MusicInfo = {
  status: 'playing' | 'paused' | 'stopped' | 'unavailable';
  playerName: string | null;
  artist: string | null;
  title: string | null;
  album: string | null;
  source: 'playerctl' | 'manual' | 'none';
  updatedAt: string;
};

const port = Number(process.env.PORT ?? 4317);
const twitchChannel = process.env.TWITCH_CHANNEL ?? 'codeacula';
const obsUrl = process.env.OBS_WEBSOCKET_URL ?? 'ws://127.0.0.1:4455';
const obsPassword = process.env.OBS_WEBSOCKET_PASSWORD ?? '';
const musicPollIntervalMs = Number(process.env.MUSIC_POLL_INTERVAL_MS ?? 2000);
const musicPlayerctlPlayer = process.env.MUSIC_PLAYERCTL_PLAYER?.trim() || 'strawberry';
const quackVolume = Math.max(0, Math.min(1, Number(process.env.QUACK_VOLUME ?? 0.2)));
const quackSounds = [
  '/sounds/quacks/075176_duck-quack-40345.mp3',
  '/sounds/quacks/duck-quack-112941.mp3',
  '/sounds/quacks/duck-quacking-37392.mp3'
];

let twitchRoomId: string | null = null;
const sessionChatters = new Set<string>();
const serverStartedAt = Date.now();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(__dirname, '..', 'data');
mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'streamer-tools.sqlite'));

db.exec('pragma journal_mode = WAL');
db.exec(`
  create table if not exists chat_messages (
    id text primary key,
    channel text not null,
    username text not null,
    display_name text not null,
    color text,
    message text not null,
    received_at text not null,
    deleted_at text,
    deleted_reason text,
    moderation_event_id text
  );

  create table if not exists chat_events (
    id text primary key,
    type text not null,
    channel text not null,
    message_id text,
    username text,
    payload_json text not null,
    occurred_at text not null
  );

  create table if not exists stream_goals (
    id text primary key,
    label text not null,
    current integer not null,
    target integer not null
  );

  create table if not exists sound_buttons (
    id text primary key,
    label text not null,
    filename text not null
  );

  create table if not exists stream_events (
    id text primary key,
    kind text not null,
    actor text not null,
    detail text not null,
    tone text not null,
    received_at text not null
  );
`);

function addColumnIfMissing(table: string, column: string, definition: string) {
  const columns = db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((row) => row.name === column)) {
    db.exec(`alter table ${table} add column ${column} ${definition}`);
  }
}

addColumnIfMissing('chat_messages', 'deleted_at', 'text');
addColumnIfMissing('chat_messages', 'deleted_reason', 'text');
addColumnIfMissing('chat_messages', 'moderation_event_id', 'text');
addColumnIfMissing('chat_messages', 'badges_json', 'text');
addColumnIfMissing('chat_messages', 'emotes_json', 'text');

let runtimeUserToken: string | null = null;

function getEventSubCredentials(): { clientId: string; userToken: string } | null {
  const clientId = process.env.TWITCH_CLIENT_ID ?? '';
  const userToken = runtimeUserToken ?? process.env.TWITCH_USER_TOKEN ?? '';
  if (!clientId || !userToken) return null;
  return { clientId, userToken };
}

// ─── EventSub ─────────────────────────────────────────────────────────────

let eventSubWs: WebSocket | null = null;
let eventSubConnected = false;
let broadcasterId: string | null = null;
let eventSubKeepaliveMs = 20_000;
let eventSubKeepaliveTimer: ReturnType<typeof setTimeout> | null = null;

const insertStreamEvent = db.prepare(`
  insert or ignore into stream_events (id, kind, actor, detail, tone, received_at)
  values (?, ?, ?, ?, ?, ?)
`);

function emitStreamEvent(kind: string, actor: string, detail: string, tone: string) {
  const id = crypto.randomUUID();
  const receivedAt = new Date().toISOString();
  insertStreamEvent.run(id, kind, actor, detail, tone, receivedAt);
  broadcast('stream:event', { id, kind, actor, detail, tone, ago: 'just now', receivedAt });
}

function tierLabel(tier: string): string {
  if (tier === '2000') return 'Tier 2';
  if (tier === '3000') return 'Tier 3';
  return 'Tier 1';
}

function handleEventSubNotification(type: string, event: Record<string, unknown>) {
  switch (type) {
    case 'channel.follow':
      emitStreamEvent('follow', event.user_name as string, 'followed', 'silver');
      break;
    case 'channel.subscribe':
      if (!(event.is_gift as boolean)) {
        emitStreamEvent('sub', event.user_name as string,
          `subscribed · ${tierLabel(event.tier as string)}`, 'warning');
      }
      break;
    case 'channel.subscription.message':
      emitStreamEvent('sub', event.user_name as string,
        `resubscribed · ${event.cumulative_months} months · ${tierLabel(event.tier as string)}`, 'warning');
      break;
    case 'channel.subscription.gift':
      emitStreamEvent('gift',
        (event.user_name as string) || 'Anonymous',
        `gifted ${event.total} sub${(event.total as number) !== 1 ? 's' : ''} to the channel`, 'warning');
      break;
    case 'channel.cheer':
      emitStreamEvent('cheer',
        (event.user_name as string) || 'Anonymous',
        `cheered ${event.bits} bits`, 'info');
      break;
    case 'channel.raid':
      emitStreamEvent('raid',
        event.from_broadcaster_user_name as string,
        `raided with ${event.viewers} viewer${(event.viewers as number) !== 1 ? 's' : ''}`, 'note');
      break;
    case 'channel.channel_points_custom_reward_redemption.add':
      emitStreamEvent('redeem',
        event.user_name as string,
        `redeemed "${(event.reward as { title: string }).title}"`, 'info');
      break;
  }
}

async function fetchBroadcasterId(clientId: string, userToken: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://api.twitch.tv/helix/users?login=${encodeURIComponent(twitchChannel)}`,
      { headers: { 'Client-Id': clientId, 'Authorization': `Bearer ${userToken}` } }
    );
    if (!res.ok) return null;
    const data = await res.json() as { data: Array<{ id: string }> };
    return data.data[0]?.id ?? null;
  } catch {
    return null;
  }
}

async function createEventSubSubscription(
  clientId: string, userToken: string, sessionId: string,
  type: string, version: string, condition: Record<string, string>
) {
  try {
    const res = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
      method: 'POST',
      headers: {
        'Client-Id': clientId,
        'Authorization': `Bearer ${userToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ type, version, condition, transport: { method: 'websocket', session_id: sessionId } })
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(`EventSub: failed to subscribe to ${type} (${res.status}):`, text);
    }
  } catch (err) {
    console.error(`EventSub: error subscribing to ${type}:`, err);
  }
}

async function subscribeToAllEvents(clientId: string, userToken: string, sessionId: string, bid: string) {
  const subs: Array<[string, string, Record<string, string>]> = [
    ['channel.follow', '2', { broadcaster_user_id: bid, moderator_user_id: bid }],
    ['channel.subscribe', '1', { broadcaster_user_id: bid }],
    ['channel.subscription.gift', '1', { broadcaster_user_id: bid }],
    ['channel.subscription.message', '1', { broadcaster_user_id: bid }],
    ['channel.cheer', '1', { broadcaster_user_id: bid }],
    ['channel.raid', '1', { to_broadcaster_user_id: bid }],
    ['channel.channel_points_custom_reward_redemption.add', '1', { broadcaster_user_id: bid }],
  ];
  for (const [type, version, condition] of subs) {
    await createEventSubSubscription(clientId, userToken, sessionId, type, version, condition);
  }
  console.log('EventSub: all subscriptions created');
}

function clearKeepaliveTimer() {
  if (eventSubKeepaliveTimer !== null) {
    clearTimeout(eventSubKeepaliveTimer);
    eventSubKeepaliveTimer = null;
  }
}

function resetKeepaliveTimer() {
  clearKeepaliveTimer();
  eventSubKeepaliveTimer = setTimeout(() => {
    console.log('EventSub: keepalive timeout, reconnecting...');
    connectEventSub();
  }, eventSubKeepaliveMs);
}

function connectEventSub(reconnectUrl?: string) {
  const creds = getEventSubCredentials();
  if (!creds) {
    console.log('EventSub: no credentials configured, skipping');
    return;
  }

  if (!reconnectUrl && eventSubWs) {
    try { eventSubWs.close(); } catch {}
    eventSubWs = null;
  }
  eventSubConnected = false;

  const ws = new WebSocket(reconnectUrl ?? 'wss://eventsub.wss.twitch.tv/ws');
  eventSubWs = ws;

  ws.addEventListener('open', () => {
    console.log('EventSub: WebSocket connected');
  });

  ws.addEventListener('message', (evt) => {
    if (typeof evt.data !== 'string') return;

    type EventSubMsg = {
      metadata: { message_type: string };
      payload: {
        session?: { id: string; keepalive_timeout_seconds: number; reconnect_url?: string };
        subscription?: { type: string };
        event?: Record<string, unknown>;
      };
    };

    let msg: EventSubMsg;
    try { msg = JSON.parse(evt.data); } catch { return; }

    const msgType = msg.metadata.message_type;

    if (msgType === 'session_welcome') {
      const session = msg.payload.session!;
      eventSubConnected = true;
      eventSubKeepaliveMs = (session.keepalive_timeout_seconds + 10) * 1000;
      resetKeepaliveTimer();
      console.log(`EventSub: session ${session.id} established`);

      if (!reconnectUrl) {
        void (async () => {
          if (!broadcasterId) {
            broadcasterId = await fetchBroadcasterId(creds.clientId, creds.userToken);
          }
          if (broadcasterId) {
            await subscribeToAllEvents(creds.clientId, creds.userToken, session.id, broadcasterId);
          } else {
            console.error(`EventSub: could not resolve broadcaster ID for "${twitchChannel}"`);
          }
        })();
      }

    } else if (msgType === 'session_keepalive') {
      resetKeepaliveTimer();

    } else if (msgType === 'session_reconnect') {
      const newUrl = msg.payload.session?.reconnect_url;
      if (newUrl) {
        console.log('EventSub: reconnecting to new URL...');
        const staleWs = ws;
        connectEventSub(newUrl);
        setTimeout(() => { try { staleWs.close(); } catch {} }, 30_000);
      }

    } else if (msgType === 'notification') {
      const subType = msg.payload.subscription?.type ?? '';
      const event = msg.payload.event ?? {};
      handleEventSubNotification(subType, event);

    } else if (msgType === 'revocation') {
      const sub = msg.payload.subscription as { type?: string; status?: string } | undefined;
      console.warn('EventSub: subscription revoked:', sub?.type, sub?.status);
    }
  });

  ws.addEventListener('close', (evt) => {
    if (ws !== eventSubWs) return;
    eventSubConnected = false;
    clearKeepaliveTimer();
    console.log(`EventSub: disconnected (code ${(evt as CloseEvent).code}), retrying in 10s...`);
    setTimeout(() => connectEventSub(), 10_000);
  });

  ws.addEventListener('error', () => {
    console.error('EventSub: WebSocket error');
  });
}

const app = express();
app.use(express.json());

const server = createServer(app);
const sockets = new Set<WsSocket>();
const wss = new WebSocketServer({ server, path: '/socket' });

function broadcast(event: string, payload: unknown) {
  const body = JSON.stringify({ event, payload });
  for (const socket of sockets) {
    if (socket.readyState === socket.OPEN) {
      socket.send(body);
    }
  }
}

function triggerQuackSound() {
  const src = quackSounds[Math.floor(Math.random() * quackSounds.length)];
  const payload = {
    id: crypto.randomUUID(),
    src,
    volume: quackVolume
  };
  broadcast('sound:play', payload);
  return payload;
}

wss.on('connection', (socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});

let currentMusic: MusicInfo = {
  status: 'unavailable',
  playerName: null,
  artist: null,
  title: null,
  album: null,
  source: 'none',
  updatedAt: new Date().toISOString()
};
let lastMusicFingerprint = '';
let musicPollRunning = false;
let manualMusicActive = false;

function cleanMetadata(value: string) {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeStatus(status: string): MusicInfo['status'] {
  const normalized = status.trim().toLowerCase();
  if (normalized === 'playing') return 'playing';
  if (normalized === 'paused') return 'paused';
  if (normalized === 'stopped') return 'stopped';
  return 'unavailable';
}

function unavailableMusic(): MusicInfo {
  return {
    status: 'unavailable',
    playerName: null,
    artist: null,
    title: null,
    album: null,
    source: 'none',
    updatedAt: new Date().toISOString()
  };
}

function updateMusic(nextMusic: MusicInfo) {
  currentMusic = nextMusic;

  const fingerprint = JSON.stringify({
    status: currentMusic.status,
    playerName: currentMusic.playerName,
    artist: currentMusic.artist,
    title: currentMusic.title,
    album: currentMusic.album,
    source: currentMusic.source
  });

  if (fingerprint !== lastMusicFingerprint) {
    lastMusicFingerprint = fingerprint;
    broadcast('music:updated', currentMusic);
  }
}

async function readPlayerctlMusicForPlayer(playerName: string | null): Promise<MusicInfo> {
  const updatedAt = new Date().toISOString();
  const playerArgs = playerName ? ['--player', playerName] : [];
  const statusResult = await execFileAsync('playerctl', [...playerArgs, 'status'], { timeout: 1200 });
  const metadataResult = await execFileAsync(
    'playerctl',
    [...playerArgs, 'metadata', '--format', '{{playerName}}\t{{artist}}\t{{title}}\t{{album}}'],
    { timeout: 1200 }
  );
  const [reportedPlayerName = '', artist = '', title = '', album = ''] = metadataResult.stdout.trimEnd().split('\t');

  return {
    status: normalizeStatus(statusResult.stdout),
    playerName: cleanMetadata(reportedPlayerName) ?? playerName,
    artist: cleanMetadata(artist),
    title: cleanMetadata(title),
    album: cleanMetadata(album),
    source: 'playerctl',
    updatedAt
  };
}

async function readPlayerctlMusic(): Promise<MusicInfo> {
  if (musicPlayerctlPlayer) {
    return readPlayerctlMusicForPlayer(musicPlayerctlPlayer);
  }

  const playersResult = await execFileAsync('playerctl', ['-l'], { timeout: 1200 });
  const players = playersResult.stdout
    .split('\n')
    .map((player) => player.trim())
    .filter(Boolean);

  if (players.length === 0) {
    return readPlayerctlMusicForPlayer(null);
  }

  const results = await Promise.allSettled(players.map((player) => readPlayerctlMusicForPlayer(player)));
  const candidates = results
    .filter((result): result is PromiseFulfilledResult<MusicInfo> => result.status === 'fulfilled')
    .map((result) => result.value)
    .filter((music) => music.title);

  const playing = candidates.find((music) => music.status === 'playing');
  if (playing) return playing;

  const paused = candidates.find((music) => music.status === 'paused');
  if (paused) return paused;

  if (candidates[0]) return candidates[0];
  return readPlayerctlMusicForPlayer(null);
}

async function pollMusic() {
  if (manualMusicActive) return;
  if (musicPollRunning) return;
  musicPollRunning = true;

  try {
    updateMusic(await readPlayerctlMusic());
  } catch {
    updateMusic(unavailableMusic());
  } finally {
    musicPollRunning = false;
  }
}

if (musicPollIntervalMs > 0) {
  pollMusic();
  setInterval(pollMusic, musicPollIntervalMs);
}

const insertChat = db.prepare(`
  insert or ignore into chat_messages
    (id, channel, username, display_name, color, message, received_at, deleted_at, deleted_reason, badges_json, emotes_json)
  values
    (?, ?, ?, ?, ?, ?, ?, null, null, ?, ?)
`);

const insertChatEvent = db.prepare(`
  insert into chat_events
    (id, type, channel, message_id, username, payload_json, occurred_at)
  values
    (?, ?, ?, ?, ?, ?, ?)
`);

const markMessageDeleted = db.prepare(`
  update chat_messages
  set deleted_at = ?, deleted_reason = ?, moderation_event_id = ?
  where id = ?
`);

const markUserMessagesDeleted = db.prepare(`
  update chat_messages
  set deleted_at = ?, deleted_reason = ?, moderation_event_id = ?
  where channel = ? and lower(username) = lower(?) and deleted_at is null
`);

const markChannelMessagesDeleted = db.prepare(`
  update chat_messages
  set deleted_at = ?, deleted_reason = ?, moderation_event_id = ?
  where channel = ? and deleted_at is null
`);

function appendChatEvent(
  type: string,
  channel: string,
  payload: unknown,
  options: { messageId?: string | null; username?: string | null; occurredAt?: string } = {}
) {
  const occurredAt = options.occurredAt ?? new Date().toISOString();
  const id = crypto.randomUUID();

  insertChatEvent.run(
    id,
    type,
    channel.replace(/^#/, ''),
    options.messageId ?? null,
    options.username ?? null,
    JSON.stringify(payload),
    occurredAt
  );

  return { id, occurredAt };
}

const twitchClient = new tmi.Client({
  connection: { reconnect: true, secure: true },
  channels: [twitchChannel]
});

twitchClient.on('message', (channel, tags, message, self) => {
  if (self) return;

  if (!twitchRoomId && tags['room-id']) {
    twitchRoomId = String(tags['room-id']);
  }

  const occurredAt = new Date().toISOString();
  const username = (tags.username ?? 'unknown').toLowerCase();
  const isFirstTimer = !sessionChatters.has(username);
  sessionChatters.add(username);

  const chatMessage: ChatMessage = {
    id: tags.id ?? crypto.randomUUID(),
    channel: channel.replace(/^#/, ''),
    username: tags.username ?? 'unknown',
    displayName: tags['display-name'] ?? tags.username ?? 'unknown',
    color: tags.color ?? null,
    message,
    receivedAt: occurredAt,
    deletedAt: null,
    deletedReason: null,
    badges: (tags.badges as Record<string, string> | null) ?? null,
    emotes: (tags.emotes as Record<string, string[]> | null) ?? null,
    isFirstTimer,
  };

  appendChatEvent('message.created', chatMessage.channel, { tags, message }, {
    messageId: chatMessage.id,
    username: chatMessage.username,
    occurredAt
  });

  insertChat.run(
    chatMessage.id,
    chatMessage.channel,
    chatMessage.username,
    chatMessage.displayName,
    chatMessage.color,
    chatMessage.message,
    chatMessage.receivedAt,
    chatMessage.badges ? JSON.stringify(chatMessage.badges) : null,
    chatMessage.emotes ? JSON.stringify(chatMessage.emotes) : null,
  );
  broadcast('chat:message', chatMessage);

  if (/^!quack\b/i.test(message.trim())) {
    triggerQuackSound();
  }
});

twitchClient.on('messagedeleted', (channel, username, deletedMessage, tags) => {
  const normalizedChannel = channel.replace(/^#/, '');
  const messageId = tags['target-msg-id'];
  const event = appendChatEvent(
    'message.deleted',
    normalizedChannel,
    { username, deletedMessage, tags },
    { messageId, username }
  );

  if (messageId) {
    markMessageDeleted.run(event.occurredAt, 'message deleted by moderator', event.id, messageId);
  }

  broadcast('chat:moderated', {
    type: 'message.deleted',
    channel: normalizedChannel,
    messageId,
    username,
    deletedAt: event.occurredAt,
    deletedReason: 'message deleted by moderator'
  });
});

twitchClient.on('timeout', (channel, username, reason, duration, tags) => {
  const normalizedChannel = channel.replace(/^#/, '');
  const event = appendChatEvent('user.timeout', normalizedChannel, { username, reason, duration, tags }, { username });
  const deletedReason = `timeout: ${reason || 'no reason provided'}`;

  markUserMessagesDeleted.run(event.occurredAt, deletedReason, event.id, normalizedChannel, username);
  broadcast('chat:moderated', {
    type: 'user.timeout',
    channel: normalizedChannel,
    username,
    deletedAt: event.occurredAt,
    deletedReason
  });
});

twitchClient.on('ban', (channel, username, reason, tags) => {
  const normalizedChannel = channel.replace(/^#/, '');
  const event = appendChatEvent('user.ban', normalizedChannel, { username, reason, tags }, { username });
  const deletedReason = `ban: ${reason || 'no reason provided'}`;

  markUserMessagesDeleted.run(event.occurredAt, deletedReason, event.id, normalizedChannel, username);
  broadcast('chat:moderated', {
    type: 'user.ban',
    channel: normalizedChannel,
    username,
    deletedAt: event.occurredAt,
    deletedReason
  });
});

twitchClient.on('clearchat', (channel) => {
  const normalizedChannel = channel.replace(/^#/, '');
  const event = appendChatEvent('chat.clear', normalizedChannel, {});

  markChannelMessagesDeleted.run(event.occurredAt, 'chat cleared', event.id, normalizedChannel);
  broadcast('chat:moderated', {
    type: 'chat.clear',
    channel: normalizedChannel,
    deletedAt: event.occurredAt,
    deletedReason: 'chat cleared'
  });
});

twitchClient.connect().catch((error: unknown) => {
  console.error('Failed to connect to Twitch chat:', error);
});

const obs = new OBSWebSocket();
let obsConnected = false;

async function ensureObs() {
  if (obsConnected) return;

  try {
    await obs.connect(obsUrl, obsPassword || undefined);
    obsConnected = true;
  } catch (error) {
    obsConnected = false;
    throw error;
  }
}

obs.on('ConnectionClosed', () => {
  obsConnected = false;
});

app.get('/api/health', (_request, response) => {
  response.json({ ok: true, twitchChannel, obsConnected, twitchRoomId, eventSubConnected });
});

const TWITCH_OAUTH_SCOPES = [
  'moderator:read:followers',
  'channel:read:subscriptions',
  'bits:read',
  'channel:read:redemptions',
].join(' ');

const twitchRedirectUri = process.env.TWITCH_REDIRECT_URI ?? 'http://localhost:5173/api/auth/twitch/callback';

app.get('/api/auth/twitch', (_request, response) => {
  const clientId = process.env.TWITCH_CLIENT_ID ?? '';
  if (!clientId) {
    response.status(500).send('TWITCH_CLIENT_ID not configured');
    return;
  }
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: twitchRedirectUri,
    response_type: 'code',
    scope: TWITCH_OAUTH_SCOPES,
  });
  response.redirect(`https://id.twitch.tv/oauth2/authorize?${params.toString()}`);
});

app.get('/api/auth/twitch/callback', async (request, response) => {
  const clientId = process.env.TWITCH_CLIENT_ID ?? '';
  const clientSecret = process.env.TWITCH_CLIENT_SECRET ?? '';
  const code = request.query['code'] as string | undefined;
  const error = request.query['error'] as string | undefined;

  if (error || !code) {
    response.status(400).send(`Twitch OAuth error: ${error ?? 'missing code'}`);
    return;
  }

  const redirectUri = twitchRedirectUri;

  try {
    const tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }),
    });
    const tokenData = await tokenRes.json() as { access_token?: string; error?: string };
    if (!tokenRes.ok || !tokenData.access_token) {
      response.status(500).send(`Token exchange failed: ${tokenData.error ?? tokenRes.statusText}`);
      return;
    }
    runtimeUserToken = tokenData.access_token;
    console.log('OAuth: user token acquired, reconnecting EventSub...');
    connectEventSub();
    response.redirect('/');
  } catch (err) {
    console.error('OAuth callback error:', err);
    response.status(500).send('Internal error during token exchange');
  }
});

app.get('/api/music/current', (_request, response) => {
  response.json(currentMusic);
});

app.put('/api/music/current', (request, response) => {
  const body = request.body as Partial<Record<keyof MusicInfo, unknown>>;
  const title = typeof body.title === 'string' ? cleanMetadata(body.title) : null;
  const artist = typeof body.artist === 'string' ? cleanMetadata(body.artist) : null;
  const album = typeof body.album === 'string' ? cleanMetadata(body.album) : null;
  const playerName = typeof body.playerName === 'string' ? cleanMetadata(body.playerName) : 'Manual';
  const status = typeof body.status === 'string' ? normalizeStatus(body.status) : title ? 'playing' : 'stopped';

  if (status === 'unavailable') {
    response.status(400).json({ error: 'status must be playing, paused, or stopped' });
    return;
  }

  manualMusicActive = true;
  updateMusic({
    status,
    playerName,
    artist,
    title,
    album,
    source: 'manual',
    updatedAt: new Date().toISOString()
  });
  response.json(currentMusic);
});

app.delete('/api/music/current', async (_request, response) => {
  manualMusicActive = false;
  await pollMusic();
  response.json(currentMusic);
});

app.get('/api/chat/recent', (_request, response) => {
  const rows = db
    .prepare(`
      select
        id,
        channel,
        username,
        display_name as displayName,
        color,
        message,
        received_at as receivedAt,
        deleted_at as deletedAt,
        deleted_reason as deletedReason,
        badges_json as badgesJson,
        emotes_json as emotesJson
      from chat_messages
      order by received_at desc
      limit 40
    `)
    .all()
    .reverse()
    .map((row) => {
      const r = row as Record<string, unknown> & { badgesJson: string | null; emotesJson: string | null };
      const { badgesJson, emotesJson, ...rest } = r;
      return {
        ...rest,
        badges: badgesJson ? JSON.parse(badgesJson) : null,
        emotes: emotesJson ? JSON.parse(emotesJson) : null,
      };
    });

  response.json(rows);
});

app.get('/api/chat/events/recent', (_request, response) => {
  const rows = db
    .prepare(`
      select
        id,
        type,
        channel,
        message_id as messageId,
        username,
        payload_json as payloadJson,
        occurred_at as occurredAt
      from chat_events
      order by occurred_at desc
      limit 100
    `)
    .all()
    .reverse()
    .map((row) => {
      const event = row as Record<string, unknown> & { payloadJson: string };
      const { payloadJson, ...rest } = event;
      return { ...rest, payload: JSON.parse(payloadJson) };
    });

  response.json(rows);
});


app.post('/api/obs/scenes/:sceneName', async (request, response) => {
  try {
    await ensureObs();
    await obs.call('SetCurrentProgramScene', { sceneName: request.params.sceneName });
    response.json({ ok: true });
  } catch (error) {
    response.status(502).json({ error: error instanceof Error ? error.message : 'OBS scene switch failed' });
  }
});

app.post('/api/obs/transition', async (request, response) => {
  try {
    await ensureObs();
    await obs.call('TriggerStudioModeTransition');
    response.json({ ok: true });
  } catch (error) {
    response.status(502).json({ error: error instanceof Error ? error.message : 'OBS transition failed' });
  }
});

app.post('/api/sounds/quack', (_request, response) => {
  response.json(triggerQuackSound());
});

let emoteCacheTime = 0;
let emoteCache: Record<string, string> = {};
const EMOTE_CACHE_TTL = 10 * 60 * 1000;

app.get('/api/emotes', async (_request, response) => {
  const now = Date.now();
  if (now - emoteCacheTime < EMOTE_CACHE_TTL && Object.keys(emoteCache).length > 0) {
    response.json(emoteCache);
    return;
  }

  const map: Record<string, string> = {};

  try {
    const bttvGlobal = await fetch('https://api.betterttv.net/3/cached/emotes/global').then(
      (r) => r.json() as Promise<Array<{ code: string; id: string }>>
    );
    for (const emote of bttvGlobal) {
      map[emote.code] = `https://cdn.betterttv.net/emote/${emote.id}/1x`;
    }
  } catch {}

  try {
    const stv = await fetch('https://7tv.io/v3/emote-sets/global').then(
      (r) => r.json() as Promise<{ emotes: Array<{ id: string; name: string }> }>
    );
    for (const emote of stv.emotes ?? []) {
      map[emote.name] = `https://cdn.7tv.app/emote/${emote.id}/1x.webp`;
    }
  } catch {}

  if (twitchRoomId) {
    try {
      const bttvChannel = await fetch(
        `https://api.betterttv.net/3/cached/users/twitch/${twitchRoomId}`
      ).then(
        (r) =>
          r.json() as Promise<{
            channelEmotes: Array<{ code: string; id: string }>;
            sharedEmotes: Array<{ code: string; id: string }>;
          }>
      );
      for (const emote of [...(bttvChannel.channelEmotes ?? []), ...(bttvChannel.sharedEmotes ?? [])]) {
        map[emote.code] = `https://cdn.betterttv.net/emote/${emote.id}/1x`;
      }
    } catch {}

    try {
      const stv7 = await fetch(`https://7tv.io/v3/users/twitch/${twitchRoomId}`).then(
        (r) =>
          r.json() as Promise<{
            emote_set?: { emotes: Array<{ id: string; name: string }> };
          }>
      );
      for (const emote of stv7.emote_set?.emotes ?? []) {
        map[emote.name] = `https://cdn.7tv.app/emote/${emote.id}/1x.webp`;
      }
    } catch {}
  }

  emoteCache = map;
  emoteCacheTime = now;
  response.json(map);
});

function formatAgo(receivedAt: string): string {
  const diffMs = Date.now() - new Date(receivedAt).getTime();
  const totalSecs = Math.max(0, Math.floor(diffMs / 1000));
  if (totalSecs < 60) return 'just now';
  if (totalSecs < 3600) {
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }
  if (totalSecs < 86_400) {
    const hours = Math.floor(totalSecs / 3600);
    const mins = Math.floor((totalSecs % 3600) / 60);
    return `${hours}h ${mins}m`;
  }
  const days = Math.floor(totalSecs / 86_400);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function formatClockTime(receivedAt: string): string {
  return new Date(receivedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function formatFirstSeen(receivedAt: string): string {
  const date = new Date(receivedAt);
  return `first seen ${date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}`;
}

function rolesFromBadges(badges: Record<string, string> | null): string[] {
  if (!badges) return [];
  const roles: string[] = [];
  if (badges.broadcaster) roles.push('broadcaster');
  if (badges.moderator) roles.push('mod');
  if (badges.vip) roles.push('vip');
  if (badges.subscriber) roles.push('sub');
  return roles;
}

function parseBadgesJson(value: string | null): Record<string, string> | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as Record<string, string>;
  } catch {
    return null;
  }
}

function fallbackColor(login: string): string {
  const palette = ['#ffc488', '#d7dce2', '#a8e0c4', '#9ccae8', '#bca6f0', '#f0a99d', '#f5f2e0'];
  let hash = 0;
  for (const char of login) hash = (hash + char.charCodeAt(0)) % palette.length;
  return palette[hash];
}

function getKnownChatterCount(): number {
  const row = db.prepare('select count(distinct lower(username)) as count from chat_messages').get() as { count: number };
  return row.count;
}

function getActiveChatterCount(): number {
  const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const row = db
    .prepare('select count(distinct lower(username)) as count from chat_messages where received_at >= ?')
    .get(since) as { count: number };
  return row.count;
}

async function getObsDashboardStats() {
  type ObsStreamStatus = {
    outputActive?: boolean;
    outputDuration?: number;
    outputSkippedFrames?: number;
    outputTotalFrames?: number;
  };
  type ObsStats = {
    outputSkippedFrames?: number;
    outputTotalFrames?: number;
    renderSkippedFrames?: number;
    outputBytes?: number;
    activeFps?: number;
  };

  const withTimeout = async <T,>(promise: Promise<T>, ms: number): Promise<T> => {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('OBS request timed out')), ms);
      promise.then(
        value => {
          clearTimeout(timer);
          resolve(value);
        },
        error => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  };

  try {
    await withTimeout(ensureObs(), 1200);
    const [streamStatus, stats] = await Promise.all([
      withTimeout(obs.call('GetStreamStatus') as Promise<ObsStreamStatus>, 1200),
      withTimeout(obs.call('GetStats') as Promise<ObsStats>, 1200),
    ]);
    const uptimeSeconds = typeof streamStatus.outputDuration === 'number'
      ? Math.floor(streamStatus.outputDuration / 1000)
      : null;
    const totalFrames = streamStatus.outputTotalFrames ?? stats.outputTotalFrames ?? null;
    const droppedFrames = streamStatus.outputSkippedFrames ?? stats.outputSkippedFrames ?? null;
    const elapsedSeconds = Math.max(1, Math.floor((Date.now() - serverStartedAt) / 1000));
    const bitrateKbps = typeof stats.outputBytes === 'number' && streamStatus.outputActive
      ? Math.round((stats.outputBytes * 8) / elapsedSeconds / 1000)
      : null;

    return {
      streamActive: streamStatus.outputActive ?? null,
      uptimeSeconds,
      bitrateKbps,
      totalFrames,
      droppedFrames,
      laggedFrames: stats.renderSkippedFrames ?? null,
    };
  } catch {
    obsConnected = false;
    return {
      streamActive: null,
      uptimeSeconds: null,
      bitrateKbps: null,
      totalFrames: null,
      droppedFrames: null,
      laggedFrames: null,
    };
  }
}

app.get('/api/dashboard/status', async (_request, response) => {
  const obsStats = await getObsDashboardStats();
  response.json({
    channel: twitchChannel,
    chatConnection: twitchClient.readyState?.() ?? 'UNKNOWN',
    obsConnected,
    eventSubConnected,
    ...obsStats,
    activeChatters: getActiveChatterCount(),
    sessionChatters: sessionChatters.size,
    knownChatters: getKnownChatterCount(),
    nextAdSeconds: null,
  });
});

app.get('/api/dashboard/viewers', (_request, response) => {
  const countRows = db.prepare(`
    select lower(username) as login, count(*) as msgs, min(received_at) as firstSeen
    from chat_messages
    group by lower(username)
  `).all() as Array<{ login: string; msgs: number; firstSeen: string }>;

  const counts = new Map(countRows.map(row => [row.login, row]));
  const recentRows = db.prepare(`
    select username, display_name as displayName, color, message, received_at as receivedAt, badges_json as badgesJson
    from chat_messages
    order by received_at desc
    limit 500
  `).all() as Array<{
    username: string;
    displayName: string;
    color: string | null;
    message: string;
    receivedAt: string;
    badgesJson: string | null;
  }>;

  type ViewerProjection = {
    login: string;
    display: string;
    color: string;
    pronouns: string;
    roles: string[];
    followed: string;
    subbed: string;
    seen: string;
    msgs: number;
    accountAge: string;
    note: string;
    recent: Array<{ t: string; ago: string; kind?: string }>;
  };

  const viewers: Record<string, ViewerProjection> = {};
  for (const row of recentRows) {
    const login = row.username.toLowerCase();
    const count = counts.get(login);
    if (!count) continue;

    if (!viewers[login]) {
      const badges = parseBadgesJson(row.badgesJson);
      const roles = rolesFromBadges(badges);
      viewers[login] = {
        login,
        display: row.displayName,
        color: row.color ?? fallbackColor(login),
        pronouns: 'not available',
        roles,
        followed: 'not available',
        subbed: roles.includes('sub') ? 'subscriber badge present' : 'not available',
        seen: formatFirstSeen(count.firstSeen),
        msgs: count.msgs,
        accountAge: 'not available',
        note: '',
        recent: [],
      };
    }

    if (viewers[login].recent.length < 5) {
      viewers[login].recent.push({
        t: row.message,
        ago: formatAgo(row.receivedAt),
      });
    }
  }

  response.json(viewers);
});

app.get('/api/dashboard/chat', (_request, response) => {
  const rows = db.prepare(`
    select id, username, message, received_at as receivedAt, badges_json as badgesJson
    from chat_messages
    order by received_at desc
    limit 80
  `).all() as Array<{ id: string; username: string; message: string; receivedAt: string; badgesJson: string | null }>;

  response.json(rows.reverse().map((row) => {
    const badges = parseBadgesJson(row.badgesJson);
    return {
      id: row.id,
      user: row.username.toLowerCase(),
      text: row.message,
      time: formatClockTime(row.receivedAt),
      highlight: badges?.subscriber ? 'sub' : undefined,
    };
  }));
});

app.get('/api/dashboard/events', (_request, response) => {
  const rows = db.prepare(`
    select id, kind, actor, detail, tone, received_at as receivedAt
    from stream_events
    order by received_at desc
    limit 50
  `).all() as Array<{ id: string; kind: string; actor: string; detail: string; tone: string; receivedAt: string }>;

  if (rows.length > 0) {
    response.json(rows.map(r => ({ ...r, ago: formatAgo(r.receivedAt) })));
    return;
  }

  response.json([]);
});

server.listen(port, () => {
  console.log(`Streamer Tools backend listening on http://localhost:${port}`);
  connectEventSub();
});
