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
import { WebSocketServer, type WebSocket } from 'ws';

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


const app = express();
app.use(express.json());

const server = createServer(app);
const sockets = new Set<WebSocket>();
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
  response.json({ ok: true, twitchChannel, obsConnected, twitchRoomId });
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

/* ---------- Test Data Endpoints ---------- */

const STUB_COLORS: Record<string, string> = {
  gold:   '#ffc488',
  silver: '#d7dce2',
  sage:   '#a8e0c4',
  sky:    '#9ccae8',
  violet: '#bca6f0',
  coral:  '#f0a99d',
  ivory:  '#f5f2e0',
};

app.get('/api/dashboard/viewers', (_request, response) => {
  response.json({
    stardust_kelly: {
      login: 'stardust_kelly', display: 'stardust_kelly', color: STUB_COLORS.violet,
      pronouns: 'she/her', roles: ['vip', 'sub'],
      followed: 'follows for 1y 3mo', subbed: 'subscribed 14 months · tier 1',
      seen: 'first seen Mar 2025', msgs: 4218, accountAge: 'account 3y 2mo',
      note: 'Mods love her — first to welcome new chatters. No warnings.',
      recent: [
        { t: 'the parallax on that starfield is unreal', ago: '0:12' },
        { t: 'wait can you show the easing curve again?', ago: '1:40' },
        { t: 'gifted a sub to moon_dev', ago: '6:02', kind: 'event' },
        { t: 'diogenes with a licensing agreement lmaooo', ago: '8:31' },
      ],
    },
    moon_dev: {
      login: 'moon_dev', display: 'moon_dev', color: STUB_COLORS.sky,
      pronouns: 'they/them', roles: ['sub'],
      followed: 'follows for 7 months', subbed: 'subscribed 2 months · gift',
      seen: 'first seen this stream', msgs: 96, accountAge: 'account 5 mo',
      note: 'New-ish. Gifted into the community by stardust_kelly tonight.',
      recent: [
        { t: 'first time catching you live, this is cozy', ago: '0:48' },
        { t: 'is the repo public?', ago: '3:22' },
        { t: 'thank you for the gift sub 🌙', ago: '5:55' },
      ],
    },
    grumpy_compiler: {
      login: 'grumpy_compiler', display: 'grumpy_compiler', color: STUB_COLORS.coral,
      pronouns: 'he/him', roles: ['mod', 'sub'],
      followed: 'follows for 2y 8mo', subbed: 'subscribed 31 months · tier 3',
      seen: 'first seen Jun 2023', msgs: 11904, accountAge: 'account 6y',
      note: 'Head mod. Trusted with everything. Runs the link bot.',
      recent: [
        { t: '!so @nebula_smith they stream rust on tuesdays', ago: '0:30' },
        { t: 'timed out a spammer, all clear', ago: '2:11', kind: 'mod' },
        { t: 'the auth refactor is gonna pay off, hold the line', ago: '4:49' },
      ],
    },
    nebula_smith: {
      login: 'nebula_smith', display: 'nebula_smith', color: STUB_COLORS.sage,
      pronouns: 'she/they', roles: [],
      followed: 'not following yet', subbed: 'not subscribed',
      seen: 'first seen this stream', msgs: 7, accountAge: 'account 11 days',
      note: 'Brand new account. Lurker so far — keep an eye, but friendly.',
      recent: [
        { t: 'hi! found you through the raid', ago: '1:05' },
        { t: 'what theme is that in the editor?', ago: '2:40' },
      ],
    },
    cosmic_jeff: {
      login: 'cosmic_jeff', display: 'cosmic_jeff', color: STUB_COLORS.gold,
      pronouns: 'he/him', roles: ['sub'],
      followed: 'follows for 1y 1mo', subbed: 'subscribed 9 months · tier 1',
      seen: 'first seen Apr 2025', msgs: 2051, accountAge: 'account 4y 6mo',
      note: 'Regular. Asks great questions about accessibility tooling.',
      recent: [
        { t: 'does the screen reader announce the live region update?', ago: '0:20' },
        { t: 'this is why I sub, actual teaching', ago: '3:58' },
      ],
    },
    pixel_witch: {
      login: 'pixel_witch', display: 'pixel_witch', color: STUB_COLORS.ivory,
      pronouns: 'she/her', roles: ['vip'],
      followed: 'follows for 1y 9mo', subbed: 'not subscribed',
      seen: 'first seen Sep 2024', msgs: 3380, accountAge: 'account 2y 9mo',
      note: 'Made the emote set. VIP for life. No warnings.',
      recent: [
        { t: 'the rim light on the orb came out so good', ago: '1:14' },
        { t: 'new emote when 👀', ago: '5:30' },
      ],
    },
  });
});

app.get('/api/dashboard/chat', (_request, response) => {
  response.json([
    { user: 'grumpy_compiler', text: '!so @nebula_smith they stream rust on tuesdays', time: '9:38' },
    { user: 'cosmic_jeff', text: 'does the screen reader announce the live region update?', time: '9:39' },
    { user: 'pixel_witch', text: 'the rim light on the orb came out so good', time: '9:39' },
    { user: 'nebula_smith', text: 'hi! found you through the raid', time: '9:40', highlight: 'first' },
    { user: 'moon_dev', text: 'first time catching you live, this is cozy', time: '9:40', highlight: 'first' },
    { user: 'stardust_kelly', text: 'diogenes with a licensing agreement lmaooo', time: '9:41' },
    { user: 'cosmic_jeff', text: 'this is why I sub, actual teaching', time: '9:41' },
    { user: 'nebula_smith', text: 'what theme is that in the editor?', time: '9:42' },
    { user: 'moon_dev', text: 'is the repo public?', time: '9:42' },
    { user: 'stardust_kelly', text: 'wait can you show the easing curve again?', time: '9:43' },
    { user: 'grumpy_compiler', text: 'the auth refactor is gonna pay off, hold the line', time: '9:43' },
    { user: 'pixel_witch', text: 'new emote when 👀', time: '9:44' },
    { user: 'cosmic_jeff', text: 'the contemplative-cozy-mystical thing really is the whole brand huh', time: '9:44' },
    { user: 'stardust_kelly', text: 'the parallax on that starfield is unreal', time: '9:45' },
    { user: 'moon_dev', text: 'thank you for the gift sub 🌙', time: '9:45', highlight: 'sub' },
  ]);
});

app.get('/api/dashboard/events', (_request, response) => {
  response.json([
    { kind: 'raid',   actor: 'aurora_codes',    detail: 'raided with 58 friends',          ago: '0:40',  tone: 'note' },
    { kind: 'gift',   actor: 'stardust_kelly',  detail: 'gifted 5 subs to the channel',    ago: '6:02',  tone: 'warning' },
    { kind: 'sub',    actor: 'cosmic_jeff',     detail: 'resubscribed · 9 months · tier 1', ago: '11:18', tone: 'warning' },
    { kind: 'cheer',  actor: 'pixel_witch',     detail: 'cheered 500 bits',                ago: '14:50', tone: 'info' },
    { kind: 'follow', actor: 'nebula_smith',    detail: 'followed',                        ago: '18:07', tone: 'silver' },
    { kind: 'sub',    actor: 'moon_dev',        detail: 'subscribed · gifted',             ago: '6:02',  tone: 'warning' },
    { kind: 'follow', actor: 'quiet_quasar',    detail: 'followed',                        ago: '22:30', tone: 'silver' },
    { kind: 'cheer',  actor: 'grumpy_compiler', detail: 'cheered 1000 bits',               ago: '24:12', tone: 'info' },
  ]);
});

server.listen(port, () => {
  console.log(`Streamer Tools backend listening on http://localhost:${port}`);
});
