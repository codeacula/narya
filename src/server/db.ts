import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(__dirname, '..', '..', 'data');
mkdirSync(dataDir, { recursive: true });

export const db = new Database(path.join(dataDir, 'streamer-tools.sqlite'));

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

  create table if not exists twitch_oauth (
    provider text primary key,
    access_token text not null,
    refresh_token text,
    scopes_json text not null,
    token_type text,
    expires_at text,
    updated_at text not null
  );

  create table if not exists viewer_profiles (
    login text primary key,
    real_name text not null default '',
    tags_json text not null default '[]',
    note text not null default '',
    created_at text not null,
    updated_at text not null
  );

  create table if not exists chatbot_commands (
    id text primary key,
    trigger text not null unique,
    enabled integer not null default 1,
    created_at text not null,
    updated_at text not null
  );

  create table if not exists chatbot_command_actions (
    id text primary key,
    command_id text not null,
    action_type text not null,
    payload_json text not null,
    enabled integer not null default 1,
    position integer not null default 0,
    created_at text not null,
    updated_at text not null,
    foreign key (command_id) references chatbot_commands(id) on delete cascade
  );

  create table if not exists llm_settings (
    id text primary key,
    enabled integer not null default 1,
    base_url text not null,
    model text not null,
    api_key text not null,
    personality_prompt text not null,
    temperature real not null default 0.7,
    max_output_tokens integer not null default 140,
    timeout_ms integer not null default 15000,
    updated_at text not null
  );

  create table if not exists runsheet_items (
    id text primary key,
    text text not null,
    done integer not null default 0,
    position integer not null default 0
  );

  create table if not exists ticker_items (
    id text primary key,
    text text not null,
    position integer not null default 0
  );

  create table if not exists stream_sessions (
    id text primary key,
    started_at text not null,
    ended_at text,
    source text not null,
    discord_message_id text,
    discord_channel_id text
  );

  create table if not exists stream_session_chatters (
    session_id text not null,
    login text not null,
    first_message_id text not null,
    first_seen_at text not null,
    primary key (session_id, login),
    foreign key (session_id) references stream_sessions(id) on delete cascade
  );

  create table if not exists go_live_settings (
    id text primary key,
    obs_scene_name text not null,
    discord_guild_id text not null default '',
    discord_guild_name text not null default '',
    discord_channel_id text not null default '',
    discord_channel_name text not null default '',
    discord_message text not null,
    updated_at text not null
  );
`);

db.exec(`
  create index if not exists idx_chat_messages_channel on chat_messages(channel);
  create index if not exists idx_chat_messages_received_at on chat_messages(received_at);
  create index if not exists idx_chat_messages_username on chat_messages(username);
  create index if not exists idx_runsheet_items_position on runsheet_items(position);
  create index if not exists idx_ticker_items_position on ticker_items(position);
  create index if not exists idx_chatbot_commands_trigger on chatbot_commands(trigger);
  create index if not exists idx_chatbot_command_actions_command on chatbot_command_actions(command_id, position);
  create index if not exists idx_stream_sessions_active on stream_sessions(ended_at, started_at);
  create index if not exists idx_stream_session_chatters_login on stream_session_chatters(login);
`);

const allowedMigrationTables = new Set([
  'chat_messages',
  'chat_events',
  'stream_goals',
  'sound_buttons',
  'stream_events',
  'twitch_oauth',
  'chatbot_commands',
  'chatbot_command_actions',
  'llm_settings',
  'runsheet_items',
  'ticker_items',
  'stream_sessions',
  'stream_session_chatters',
  'go_live_settings',
]);
const allowedMigrationColumns = new Set([
  'deleted_at',
  'deleted_reason',
  'moderation_event_id',
  'badges_json',
  'emotes_json',
  'stream_session_id',
  'is_first_in_session',
  'is_first_ever',
]);
const allowedMigrationDefinitions: Record<string, string> = {
  deleted_at: 'text',
  deleted_reason: 'text',
  moderation_event_id: 'text',
  badges_json: 'text',
  emotes_json: 'text',
  stream_session_id: 'text',
  is_first_in_session: 'integer not null default 0',
  is_first_ever: 'integer not null default 0',
};

function assertMigrationIdentifier(kind: 'table' | 'column', value: string) {
  const allowed = kind === 'table' ? allowedMigrationTables : allowedMigrationColumns;
  if (!allowed.has(value)) {
    throw new Error(`Unsafe migration ${kind}: ${value}`);
  }
}

export function addColumnIfMissing(table: string, column: string, definition: string) {
  assertMigrationIdentifier('table', table);
  assertMigrationIdentifier('column', column);
  if (allowedMigrationDefinitions[column] !== definition.trim().toLowerCase()) {
    throw new Error(`Unsafe migration definition for ${column}: ${definition}`);
  }
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
addColumnIfMissing('chat_messages', 'stream_session_id', 'text');
addColumnIfMissing('chat_messages', 'is_first_in_session', 'integer not null default 0');
addColumnIfMissing('chat_messages', 'is_first_ever', 'integer not null default 0');

db.exec('create index if not exists idx_chat_messages_stream_session on chat_messages(stream_session_id)');
