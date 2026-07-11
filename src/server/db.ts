import { Database } from 'bun:sqlite';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(__dirname, '..', '..', 'data');

// Isolate tests from the operator's real database. `bun test` sets NODE_ENV=test,
// so default to an in-memory DB there; a normal run (or an explicit
// STREAMER_TOOLS_DB) still uses the file. Without this guard a test run would
// write its fixtures straight into data/streamer-tools.sqlite and clobber live
// config (Bun ignores the `[test] env` key in bunfig.toml).
const defaultDbPath = process.env.NODE_ENV === 'test'
  ? ':memory:'
  : path.join(dataDir, 'streamer-tools.sqlite');
const dbPath = process.env.STREAMER_TOOLS_DB ?? defaultDbPath;
// The database holds Twitch access/refresh tokens, the Twitch and Discord client
// secrets, the OBS password, and the LLM API key. SQLite honours the umask, which
// on most desktops means 0644 — readable by every other account on the box. Own
// the modes explicitly instead, and re-apply them on every boot so installs that
// predate this get migrated.
if (dbPath === defaultDbPath && dbPath !== ':memory:') {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  restrictMode(dataDir, 0o700);
}

function restrictMode(target: string, mode: number): void {
  try {
    if (existsSync(target)) chmodSync(target, mode);
  } catch (error) {
    // Non-POSIX filesystems (and Windows) can reject chmod. Don't take the app
    // down over it, but don't let it pass silently either.
    console.warn(`Database: could not restrict permissions on ${target}:`, error);
  }
}

// SQLite creates the -wal/-shm sidecars with the main file's mode, so tightening
// all three here also covers the ones it recreates on later boots.
function restrictDatabaseFiles(): void {
  if (dbPath === ':memory:') return;
  for (const suffix of ['', '-wal', '-shm']) {
    restrictMode(`${dbPath}${suffix}`, 0o600);
  }
}

export const db = new Database(dbPath);

db.exec('pragma journal_mode = WAL');
// The schema declares `on delete cascade` in four places, but SQLite ignores
// every one of them unless foreign keys are enabled per-connection (the default
// is off). Without this, deleting a parent silently orphans its children.
db.exec('pragma foreign_keys = ON');
restrictDatabaseFiles();
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

  create table if not exists clip_buttons (
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

  -- Twitch fires channel.subscribe and channel.subscription.message for one
  -- resub. Persisted so a restart between the two doesn't emit a duplicate row.
  create table if not exists sub_merge_state (
    user_key text primary key,
    event_id text not null,
    has_message integer not null default 0,
    at integer not null
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
    max_output_tokens integer not null default 2048,
    timeout_ms integer not null default 15000,
    updated_at text not null
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

  create table if not exists stream_status (
    id text primary key,
    text text not null default '',
    updated_at text not null
  );

  create table if not exists viewer_reward_categories (
    id text primary key,
    name text not null unique,
    enabled integer not null default 1,
    created_at text not null,
    updated_at text not null
  );

  create table if not exists viewer_reward_category_members (
    reward_id text primary key,
    category_id text not null,
    updated_at text not null,
    foreign key (category_id) references viewer_reward_categories(id) on delete cascade
  );

  create table if not exists viewer_reward_category_games (
    category_id text not null,
    game_id text not null,
    game_name text not null,
    created_at text not null,
    primary key (category_id, game_id),
    foreign key (category_id) references viewer_reward_categories(id) on delete cascade
  );

  create table if not exists stream_categories (
    game_id text primary key,
    game_name text not null,
    box_art_url text,
    hidden integer not null default 0,
    created_at text not null
  );

  create table if not exists stream_category_tags (
    game_id text not null,
    tag text not null,
    created_at text not null,
    primary key (game_id, tag)
  );

  create table if not exists stream_tag_history (
    tag_key text primary key,
    display text not null,
    last_used_at text not null
  );

  create table if not exists tts_settings (
    id integer primary key,
    enabled integer not null default 1,
    voice_id text not null default 'nPczCjzI2devNBz1zQrb',
    speed real not null default 1.0,
    voice_profile_id text not null default 'zombiechicken',
    language_id text not null default 'en',
    tone_preset text not null default 'neutral',
    exaggeration real not null default 0.5,
    cfg_weight real not null default 0.5,
    temperature real not null default 0.8,
    volume real not null default 0.8,
    updated_at text not null default ''
  );

  create table if not exists tts_reward_enabled (
    reward_id text primary key
  );

  create table if not exists reward_media (
    reward_id text primary key,
    kind text not null,
    src text not null,
    volume real not null default 0.8,
    updated_at text not null
  );

  create table if not exists alert_settings (
    kind text primary key,          -- AlertEventKind: 'sub' | 'gift' | 'cheer' | 'raid' | 'follow'
    enabled integer not null default 0,
    template text not null default '',
    duration_ms integer not null default 6000,
    sound_src text,                 -- optional audio effect (null = none)
    sound_volume real,
    clip_src text,                  -- optional video effect (null = none)
    clip_volume real,
    updated_at text not null default ''
  );

  create table if not exists app_config (
    id text primary key,
    twitch_channel text not null default '',
    twitch_client_id text not null default '',
    twitch_client_secret text not null default '',
    obs_url text not null default '',
    obs_password text not null default '',
    obs_scenes text not null default '',
    discord_client_id text not null default '',
    discord_bot_token text not null default '',
    elevenlabs_api_key text not null default '',
    music_poll_interval_ms integer not null default 2000,
    music_playerctl_player text not null default 'strawberry',
    quack_volume real not null default 0.2,
    updated_at text not null default ''
  );

  create table if not exists automod_holds (
    id text primary key not null,
    channel text not null,
    username text not null,
    display_name text not null,
    message text not null,
    category text,
    level integer,
    held_at text not null,
    resolved_at text,
    resolution text,
    resolved_by text
  );
`);

db.exec(`
  create index if not exists idx_chat_messages_channel on chat_messages(channel);
  create index if not exists idx_chat_messages_received_at on chat_messages(received_at);
  create index if not exists idx_chat_messages_username on chat_messages(username);
  create index if not exists idx_chatbot_commands_trigger on chatbot_commands(trigger);
  create index if not exists idx_chatbot_command_actions_command on chatbot_command_actions(command_id, position);
  create index if not exists idx_stream_sessions_active on stream_sessions(ended_at, started_at);
  create index if not exists idx_stream_session_chatters_login on stream_session_chatters(login);
  create index if not exists idx_viewer_reward_category_members_category on viewer_reward_category_members(category_id);
  create index if not exists idx_viewer_reward_category_games_category on viewer_reward_category_games(category_id);
  create index if not exists idx_automod_holds_resolved_at on automod_holds(resolved_at);
`);

// The runsheet and ticker features were removed; drop their tables from databases created before that.
db.exec('drop table if exists runsheet_items;');
db.exec('drop table if exists ticker_items;');

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
  'stream_sessions',
  'stream_session_chatters',
  'go_live_settings',
  'viewer_reward_categories',
  'viewer_reward_category_members',
  'viewer_reward_category_games',
  'viewer_profiles',
  'stream_categories',
  'tts_settings',
  'tts_reward_enabled',
  'app_config',
  'alert_settings',
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
  'default_background_color',
  'voice_profile_id',
  'language_id',
  'tone_preset',
  'exaggeration',
  'cfg_weight',
  'temperature',
  'chatterbox_base_url',
  'discord_announce_error',
  'discord_announce_attempts',
  'discord_announce_terminal',
  'session_id',
  'actor_login',
  'sound_src',
  'sound_volume',
  'clip_src',
  'clip_volume',
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
  default_background_color: 'text',
  voice_profile_id: "text not null default 'zombiechicken'",
  language_id: "text not null default 'en'",
  tone_preset: "text not null default 'neutral'",
  exaggeration: 'real not null default 0.5',
  cfg_weight: 'real not null default 0.5',
  temperature: 'real not null default 0.8',
  chatterbox_base_url: "text not null default 'http://127.0.0.1:8008'",
  discord_announce_error: 'text',
  discord_announce_attempts: 'integer not null default 0',
  discord_announce_terminal: 'integer not null default 0',
  session_id: 'text',
  actor_login: 'text',
  sound_src: 'text',
  sound_volume: 'real',
  clip_src: 'text',
  clip_volume: 'real',
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
addColumnIfMissing('viewer_reward_categories', 'default_background_color', 'text');
addColumnIfMissing('tts_settings', 'voice_profile_id', "text not null default 'zombiechicken'");
addColumnIfMissing('tts_settings', 'language_id', "text not null default 'en'");
addColumnIfMissing('tts_settings', 'tone_preset', "text not null default 'neutral'");
addColumnIfMissing('tts_settings', 'exaggeration', 'real not null default 0.5');
addColumnIfMissing('tts_settings', 'cfg_weight', 'real not null default 0.5');
addColumnIfMissing('tts_settings', 'temperature', 'real not null default 0.8');
addColumnIfMissing('app_config', 'chatterbox_base_url', "text not null default 'http://127.0.0.1:8008'");
addColumnIfMissing('stream_sessions', 'discord_announce_error', 'text');
// A failed go-live announcement used to be suppressed forever. Track how many
// attempts a session has burned, and whether the failure was terminal (bad token,
// missing permission, unknown channel) or merely transient (rate limit, network),
// so a transient one can still be retried. See announceTwitchStreamOnline.
addColumnIfMissing('stream_sessions', 'discord_announce_attempts', 'integer not null default 0');
addColumnIfMissing('stream_sessions', 'discord_announce_terminal', 'integer not null default 0');
// Events recorded before this column existed stay null and read as "an earlier stream".
addColumnIfMissing('stream_events', 'session_id', 'text');
db.exec('create index if not exists idx_stream_events_session on stream_events(session_id)');
// `actor` is a display name, which for a localized name doesn't lowercase to the
// login. Rows predating this column stay null and fall back to the old guess.
addColumnIfMissing('stream_events', 'actor_login', 'text');

// Alerts gained independent sound + clip effects (replacing a single media slot).
// Tables created under the earlier schema get the new columns; the old media_*
// columns, if present, are left in place and ignored.
addColumnIfMissing('alert_settings', 'sound_src', 'text');
addColumnIfMissing('alert_settings', 'sound_volume', 'real');
addColumnIfMissing('alert_settings', 'clip_src', 'text');
addColumnIfMissing('alert_settings', 'clip_volume', 'real');

// tmi logins are already lowercase, but historically some rows were stored with
// mixed case. Normalize them once so username queries can use plain equality and
// hit idx_chat_messages_username instead of scanning under lower(username).
db.exec("update chat_messages set username = lower(username) where username != lower(username)");

db.exec('create index if not exists idx_chat_messages_stream_session on chat_messages(stream_session_id)');

// Backfill ad break events that were stored as 'redeem' before the ad_break kind existed.
db.exec(`
  UPDATE stream_events
  SET kind = 'ad_break'
  WHERE kind = 'redeem' AND actor = 'Twitch' AND detail LIKE 'ad break%'
`);

// Per-chatter summary table: gives O(1) "known chatter" checks and viewer
// message counts without scanning chat_messages. Backfilled once from the
// (now normalized) chat_messages, then maintained incrementally on insert.
db.exec(`
  create table if not exists chatters (
    login text primary key,
    first_seen_at text not null,
    message_count integer not null default 0
  )
`);

const chattersEmpty = (db.prepare('select count(*) as count from chatters').get() as { count: number }).count === 0;
const hasChatMessages = (db.prepare('select count(*) as count from chat_messages').get() as { count: number }).count > 0;
if (chattersEmpty && hasChatMessages) {
  db.exec(`
    insert into chatters (login, first_seen_at, message_count)
    select username, min(received_at), count(*)
    from chat_messages
    group by username
  `);
}

// Turning `pragma foreign_keys` on doesn't retroactively remove rows that were
// orphaned while it was off (deleting a category used to leave its game mappings
// behind). Sweep them once so the declared cascades describe the data that's
// actually there, and so nothing trips the constraint later.
for (const [childTable, childKey, parentTable] of [
  ['chatbot_command_actions', 'command_id', 'chatbot_commands'],
  ['stream_session_chatters', 'session_id', 'stream_sessions'],
  ['viewer_reward_category_members', 'category_id', 'viewer_reward_categories'],
  ['viewer_reward_category_games', 'category_id', 'viewer_reward_categories'],
] as const) {
  const orphans = db
    .prepare(`delete from ${childTable} where ${childKey} not in (select id from ${parentTable})`)
    .run() as { changes: number };
  if (orphans.changes > 0) {
    console.log(`Database: removed ${orphans.changes} orphaned ${childTable} row(s) left by the disabled foreign keys.`);
  }
}
