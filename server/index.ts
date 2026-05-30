import { Database } from 'bun:sqlite';
import express from 'express';
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import OBSWebSocket from 'obs-websocket-js';
import tmi from 'tmi.js';
import { WebSocketServer, type WebSocket } from 'ws';

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
};

type StreamGoal = {
  id: string;
  label: string;
  current: number;
  target: number;
};

const port = Number(process.env.PORT ?? 4317);
const twitchChannel = process.env.TWITCH_CHANNEL ?? 'codeacula';
const obsUrl = process.env.OBS_WEBSOCKET_URL ?? 'ws://127.0.0.1:4455';
const obsPassword = process.env.OBS_WEBSOCKET_PASSWORD ?? '';

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

const goalCount = db.prepare('select count(*) as count from stream_goals').get() as { count: number };
if (goalCount.count === 0) {
  const insertGoal = db.prepare('insert into stream_goals (id, label, current, target) values (?, ?, ?, ?)');
  insertGoal.run('followers', 'Follower goal', 0, 100);
  insertGoal.run('subs', 'Sub goal', 0, 20);
}

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

wss.on('connection', (socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});

const insertChat = db.prepare(`
  insert or ignore into chat_messages
    (id, channel, username, display_name, color, message, received_at, deleted_at, deleted_reason)
  values
    (?, ?, ?, ?, ?, ?, ?, null, null)
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

  const occurredAt = new Date().toISOString();
  const chatMessage: ChatMessage = {
    id: tags.id ?? crypto.randomUUID(),
    channel: channel.replace(/^#/, ''),
    username: tags.username ?? 'unknown',
    displayName: tags['display-name'] ?? tags.username ?? 'unknown',
    color: tags.color ?? null,
    message,
    receivedAt: occurredAt,
    deletedAt: null,
    deletedReason: null
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
    chatMessage.receivedAt
  );
  broadcast('chat:message', chatMessage);
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
  response.json({ ok: true, twitchChannel, obsConnected });
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
        deleted_reason as deletedReason
      from chat_messages
      order by received_at desc
      limit 40
    `)
    .all()
    .reverse();

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

app.get('/api/goals', (_request, response) => {
  const rows = db
    .prepare('select id, label, current, target from stream_goals order by id')
    .all() as StreamGoal[];

  response.json(rows);
});

app.patch('/api/goals/:id', (request, response) => {
  const current = Number(request.body.current);
  const target = Number(request.body.target);

  if (!Number.isFinite(current) || !Number.isFinite(target) || target <= 0) {
    response.status(400).json({ error: 'current and target are required numbers; target must be positive' });
    return;
  }

  db.prepare('update stream_goals set current = ?, target = ? where id = ?').run(current, target, request.params.id);
  const goal = db.prepare('select id, label, current, target from stream_goals where id = ?').get(request.params.id);

  broadcast('goals:updated', goal);
  response.json(goal);
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

server.listen(port, () => {
  console.log(`Streamer Tools backend listening on http://localhost:${port}`);
});
