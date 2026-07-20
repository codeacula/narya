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

/**
 * llm_interactions first shipped with `id text primary key`; it was changed to an
 * autoincrement `seq` so two turns recorded in the same millisecond order
 * deterministically. `create table if not exists` never alters an existing table, so a
 * database that already holds the old shape keeps it and then crashes when a prepared
 * statement references `seq`.
 *
 * Rebuild it rather than run a data migration: it is a rolling per-viewer cache (<=50
 * turns each) with no durable meaning — losing it just makes the bot briefly forget
 * recent chat, unlike a quote whose number is already in circulation. Guarded on the
 * missing column, so it fires exactly once and is a no-op on a fresh or already-migrated
 * database (PRAGMA on an absent table returns no rows). Returns whether it dropped.
 */
export function dropStaleLlmInteractions(database: Database): boolean {
  const columns = database.prepare("PRAGMA table_info('llm_interactions')").all() as Array<{ name: string }>;
  if (columns.length > 0 && !columns.some(column => column.name === 'seq')) {
    database.exec('drop table llm_interactions');
    return true;
  }
  return false;
}

db.exec('pragma journal_mode = WAL');
// The schema declares `on delete cascade` in four places, but SQLite ignores
// every one of them unless foreign keys are enabled per-connection (the default
// is off). Without this, deleting a parent silently orphans its children.
db.exec('pragma foreign_keys = ON');
restrictDatabaseFiles();

dropStaleLlmInteractions(db);

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

  -- Durable named tallies. The value column is deliberately signed: a counter is
  -- not necessarily a tally, and clamping at zero would discard a deliberate
  -- negative. The key column is the counter template token, and is unique.
  create table if not exists counters (
    id text primary key,
    key text not null unique,
    label text not null,
    value integer not null default 0,
    created_at text not null,
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

  -- enabled defaults to 0: a fresh install must not reach out to the Tengwar
  -- speech service until the operator turns TTS on in Settings.
  create table if not exists tts_settings (
    id integer primary key,
    enabled integer not null default 0,
    voice_id text not null default 'nPczCjzI2devNBz1zQrb',
    speed real not null default 1.0,
    voice_profile_id text not null default 'usFemale',
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

// --- Automation platform -----------------------------------------------------
// Configured media, reusable Actions, typed triggers, and category modules.
// Declared after the tables above because the foreign keys point back into
// viewer_reward_categories.
db.exec(`
  create table if not exists media_assets (
    id text primary key,
    label text not null,
    kind text not null,                 -- MediaKind: 'audio' | 'video'
    source_type text not null,          -- 'local' (under public/) | 'remote' (http(s))
    src text not null,
    volume real not null default 0.8,
    enabled integer not null default 1,
    created_at text not null,
    updated_at text not null
  );

  create table if not exists actions (
    id text primary key,
    name text not null unique,
    description text not null default '',
    enabled integer not null default 1,
    created_at text not null,
    updated_at text not null
  );

  -- Single-row master switch: while muted = 1, the executor skips any Action whose
  -- quick_disable flag is set. Persisted (survives restart) unlike the in-memory
  -- overlay-placeholder flag, because a mid-stream restart must not silently un-mute.
  create table if not exists media_mute (
    id integer primary key check (id = 1),
    muted integer not null default 0
  );

  -- Wind-down configuration. Its own table rather than app_config: these are
  -- feature settings, not credentials, and saving them must never reconnect Twitch
  -- or OBS. Same shape as go_live_settings.
  create table if not exists wind_down_settings (
    id text primary key,
    lead_minutes integer not null default 15,
    title_suffix text not null default '| Ending soon',
    title_enabled integer not null default 1,
    overlay_enabled integer not null default 1,
    updated_at text not null
  );

  -- Wind-down runtime state. Single row (id = 1) so it survives a restart.
  --
  -- base_title is PERSISTED, not held in memory: a restart while active would
  -- otherwise leave the suffix welded to the operator's Twitch title into the next
  -- stream, with nothing left that knows what the title used to be.
  --
  -- dismissed_session_id latches a manual switch-off for the rest of that stream, so
  -- the scheduler cannot re-arm one tick after the operator decided to keep going.
  create table if not exists wind_down_state (
    id integer primary key check (id = 1),
    active integer not null default 0,
    activated_at text,
    source text,
    session_id text,
    base_title text,
    -- The suffix actually applied alongside base_title, so reconcile-on-boot can
    -- strip exactly what was written rather than guessing from the currently
    -- configured suffix (which may have changed since).
    applied_suffix text,
    dismissed_session_id text
  );

  create table if not exists action_steps (
    id text primary key,
    action_id text not null,
    step_type text not null,            -- ActionStepType
    payload_json text not null,
    delay_ms integer not null default 0,
    enabled integer not null default 1,
    position integer not null default 0,
    created_at text not null,
    updated_at text not null,
    foreign key (action_id) references actions(id) on delete cascade
  );

  create table if not exists category_modules (
    id text primary key,
    name text not null unique,
    enabled integer not null default 1,
    status text not null default 'idle',   -- CategoryModuleStatus
    status_detail text not null default '',
    created_at text not null,
    updated_at text not null
  );

  -- game_id is the primary key, not a composite: that is what enforces "a Twitch
  -- category belongs to at most one module". Do not widen it.
  create table if not exists category_module_games (
    game_id text primary key,
    module_id text not null,
    game_name text not null,
    created_at text not null,
    foreign key (module_id) references category_modules(id) on delete cascade
  );

  -- A reward group may be owned by several modules (a shared "always on" group);
  -- the coordinator only toggles groups whose ownership actually changes.
  create table if not exists category_module_reward_groups (
    module_id text not null,
    group_id text not null,
    created_at text not null,
    primary key (module_id, group_id),
    foreign key (module_id) references category_modules(id) on delete cascade,
    foreign key (group_id) references viewer_reward_categories(id) on delete cascade
  );

  create table if not exists automation_triggers (
    id text primary key,
    kind text not null,                 -- AutomationTriggerKind
    action_id text not null,
    module_id text,                     -- null = global (always armed)
    enabled integer not null default 1,
    config_json text not null,          -- kind-specific; see AutomationTriggerConfig
    global_cooldown_ms integer not null default 30000,
    user_cooldown_ms integer not null default 60000,
    created_at text not null,
    updated_at text not null,
    foreign key (action_id) references actions(id) on delete cascade,
    foreign key (module_id) references category_modules(id) on delete cascade
  );

  -- Invocation log. Doubles as the dedupe table: dedupe_key holds the source
  -- event id (chat message id, EventSub message id) so a redelivery is a no-op.
  create table if not exists automation_runs (
    id text primary key,
    trigger_id text not null,
    dedupe_key text,
    actor_login text,
    status text not null,               -- ActionRunStatus
    detail text not null default '',
    ran_at text not null
  );
`);

db.exec(`
  create unique index if not exists idx_automation_runs_dedupe on automation_runs(dedupe_key) where dedupe_key is not null;
  create index if not exists idx_automation_runs_cooldown on automation_runs(trigger_id, ran_at);
  create index if not exists idx_automation_runs_user_cooldown on automation_runs(trigger_id, actor_login, ran_at);
  create index if not exists idx_action_steps_action on action_steps(action_id, position);
  create index if not exists idx_automation_triggers_kind on automation_triggers(kind, enabled);
  create index if not exists idx_automation_triggers_module on automation_triggers(module_id);
  create index if not exists idx_category_module_games_module on category_module_games(module_id);
  create index if not exists idx_media_assets_enabled on media_assets(enabled);
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

  create table if not exists quotes (
    id text primary key,
    number integer not null unique,
    slug text,
    text text not null,
    submitted_by text not null,
    submitted_by_login text not null default '',
    created_at text not null,
    shown_count integer not null default 0,
    last_shown_at text
  );

  -- Quote numbers come from here, NOT from max(number) + 1: deleting the newest
  -- quote must not let the next one inherit its number. "Quote 12" gets repeated in
  -- Discord history and screenshots long after the fact, so a number that silently
  -- comes to mean a different quote is worse than a gap in the sequence.
  create table if not exists quote_sequence (
    id integer primary key check (id = 1),
    next_number integer not null
  );
  insert or ignore into quote_sequence (id, next_number) values (1, 1);

  -- Partial: a slug is optional, so many quotes hold NULL, but a slug that IS set is
  -- a lookup handle and must resolve to exactly one quote.
  create unique index if not exists idx_quotes_slug on quotes(slug) where slug is not null;

  -- What the bot and a viewer have said to each other, so an llm_response step can
  -- replay a short conversation. Keyed by login alone: there is one bot, so its memory
  -- of a person spans commands. Rows are written only AFTER the reply reaches chat, and
  -- flushViewer deletes them outright — this is viewer chat content.
  -- seq is the ordering key, not created_at: two turns recorded in the same
  -- millisecond share a timestamp, and any random tiebreak (a UUID) would shuffle them.
  -- autoincrement guarantees a monotonic sequence that pruning deletes cannot rewind.
  create table if not exists llm_interactions (
    seq integer primary key autoincrement,
    login text not null,
    prompt text not null,
    reply text not null,
    created_at text not null
  );
  create index if not exists idx_llm_interactions_login on llm_interactions(login, seq);
`);

// The runsheet and ticker features were removed; drop their tables from databases created before that.
db.exec('drop table if exists runsheet_items;');
db.exec('drop table if exists ticker_items;');

// Versioned ledger for one-shot migrations. The schema statements above are
// idempotent by construction (`create table if not exists`, addColumnIfMissing),
// so they can re-run every boot. Data migrations cannot: deriving an Action row
// from a legacy reward binding would duplicate it on every restart. Anything
// that writes rows computed from other rows goes through runOnce.
db.exec(`
  create table if not exists schema_migrations (
    id text primary key,
    applied_at text not null
  );
`);

/**
 * A SQLite unique-index violation. Callers that care about *which* constraint
 * failed must keep that check on top of this one: widening a column-specific
 * test to any unique violation reports an unrelated collision as the wrong 409.
 */
export function isUniqueConstraintError(error: unknown): error is Error {
  return error instanceof Error && error.message.toLowerCase().includes('unique constraint failed');
}

const hasMigrationRun = db.prepare('select 1 as present from schema_migrations where id = ?');
const recordMigration = db.prepare('insert into schema_migrations (id, applied_at) values (?, ?)');

/**
 * Run `migrate` exactly once across the life of the database, recording it in the
 * ledger. The work and the ledger entry share a transaction, so a crash midway
 * rolls both back and the migration retries cleanly on the next boot.
 */
export function runOnce(id: string, migrate: () => void): void {
  if (hasMigrationRun.get(id)) return;
  db.transaction(() => {
    migrate();
    recordMigration.run(id, new Date().toISOString());
  })();
}

/** Whether a one-shot migration has already been applied. */
export function hasRunMigration(id: string): boolean {
  return hasMigrationRun.get(id) !== null;
}

const allowedMigrationTables = new Set([
  'chat_messages',
  'chat_events',
  'chatters',
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
  'actions',
  'wind_down_state',
  'stream_status',
]);
const allowedMigrationColumns = new Set([
  'account_user_id',
  'account_login',
  'twitch_user_id',
  'display_name',
  'profile_image_url',
  'account_created_at',
  'last_seen_at',
  'profile_fetched_at',
  'missing_at',
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
  'tengwar_base_url',
  'tengwar_api_key',
  'discord_announce_error',
  'discord_announce_attempts',
  'discord_announce_terminal',
  'session_id',
  'actor_login',
  'sound_src',
  'sound_volume',
  'clip_src',
  'clip_volume',
  'obs_scene_prefix',
  'sound_button_volume',
  'quick_disable',
  'planned_end_at',
  'applied_suffix',
  'raw_text',
]);
const allowedMigrationDefinitions: Record<string, string> = {
  account_user_id: 'text',
  account_login: 'text',
  deleted_at: 'text',
  deleted_reason: 'text',
  moderation_event_id: 'text',
  badges_json: 'text',
  emotes_json: 'text',
  stream_session_id: 'text',
  is_first_in_session: 'integer not null default 0',
  is_first_ever: 'integer not null default 0',
  default_background_color: 'text',
  // A Tengwar speaker id. Rows holding anything outside Tengwar's speaker set — the
  // Chatterbox-era 'zombiechicken', or a custom voice — are remapped on read in
  // tts.ts rather than rewritten here.
  //
  // Lowercased, like obs_scene_prefix above, because the guard below compares against
  // `definition.toLowerCase()`. The DDL that actually runs keeps its original case, so
  // the stored default is 'usFemale' — do not "fix" this to match the call site.
  voice_profile_id: "text not null default 'usfemale'",
  // One full base URL with the port already in it, matching obs_url's convention.
  // Splitting host and port would make a Tailscale address two fields to get right.
  tengwar_base_url: "text not null default 'http://127.0.0.1:8008'",
  tengwar_api_key: "text not null default ''",
  discord_announce_error: 'text',
  discord_announce_attempts: 'integer not null default 0',
  discord_announce_terminal: 'integer not null default 0',
  session_id: 'text',
  actor_login: 'text',
  // Viewer identity, backfilled from Helix. `twitch_user_id` is the rename-proof
  // key; the login is not, which is why a refresh can find an account under a new
  // name. `missing_at` is stamped when Twitch stops returning the account at all.
  twitch_user_id: 'text',
  display_name: 'text',
  profile_image_url: 'text',
  account_created_at: 'text',
  last_seen_at: 'text',
  profile_fetched_at: 'text',
  missing_at: 'text',
  sound_src: 'text',
  sound_volume: 'real',
  clip_src: 'text',
  clip_volume: 'real',
  // Lowercased because the guard below compares against `definition.toLowerCase()`.
  // The DDL that actually runs keeps its original case, so the stored default is
  // "Scene - ", not "scene - ".
  obs_scene_prefix: "text not null default 'scene - '",
  // Supersedes app_config.quack_volume, which named the built-in !quack command
  // rather than what it actually controls: the default sound-button volume.
  sound_button_volume: 'real not null default 0.2',
  quick_disable: 'integer not null default 0',
  planned_end_at: 'text',
  applied_suffix: 'text',
  // The operator's unrendered status line, with its {counter:key} tokens intact.
  // stream_status.text holds the rendered result, because that column feeds the
  // overlay-reachable GET and the status:updated broadcast.
  raw_text: "text not null default ''",
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

// Who each OAuth token belongs to. Recorded at login so the operator's channel can
// be derived from the account they signed in with instead of typed a second time.
addColumnIfMissing('twitch_oauth', 'account_user_id', 'text');
addColumnIfMissing('twitch_oauth', 'account_login', 'text');
addColumnIfMissing('chat_messages', 'deleted_at', 'text');
addColumnIfMissing('chat_messages', 'deleted_reason', 'text');
addColumnIfMissing('chat_messages', 'moderation_event_id', 'text');
addColumnIfMissing('chat_messages', 'badges_json', 'text');
addColumnIfMissing('chat_messages', 'emotes_json', 'text');
addColumnIfMissing('chat_messages', 'stream_session_id', 'text');
addColumnIfMissing('chat_messages', 'is_first_in_session', 'integer not null default 0');
addColumnIfMissing('chat_messages', 'is_first_ever', 'integer not null default 0');
// When the operator plans to end this stream, set from the go-live Info screen or
// the dashboard. Null for sessions with no plan and for rows predating the column.
addColumnIfMissing('stream_sessions', 'planned_end_at', 'text');
addColumnIfMissing('viewer_reward_categories', 'default_background_color', 'text');
addColumnIfMissing('tts_settings', 'voice_profile_id', "text not null default 'usFemale'");
// Speech is served by Tengwar: one full base URL (port included) plus an optional
// API key sent as X-Api-Key. See appConfig.ts for the carry-over from the
// Chatterbox-era columns these replace.
addColumnIfMissing('app_config', 'tengwar_base_url', "text not null default 'http://127.0.0.1:8008'");
addColumnIfMissing('app_config', 'tengwar_api_key', "text not null default ''");
// OBS reports which scenes exist; the operator only configures which of them are
// switch targets. Replaces app_config.obs_scenes, a hand-maintained duplicate of
// the live scene list that went stale the moment a scene was renamed in OBS.
addColumnIfMissing('app_config', 'obs_scene_prefix', "text not null default 'Scene - '");
addColumnIfMissing('app_config', 'sound_button_volume', 'real not null default 0.2');
addColumnIfMissing('actions', 'quick_disable', 'integer not null default 0');
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

// Rows created before this column existed stay null; reconcileWindDownOnBoot falls
// back to the currently configured suffix for those.
addColumnIfMissing('wind_down_state', 'applied_suffix', 'text');

// The status line split into stored-raw and rendered. An existing row's `text` is
// its raw text — it predates counters, so it holds no tokens — and is carried across
// so the operator's current status survives the upgrade.
//
// runOnce, not an unconditional update: this writes a column computed from another
// column, and re-running it after the operator has since cleared their status would
// resurrect the old text from the rendered copy.
addColumnIfMissing('stream_status', 'raw_text', "text not null default ''");
runOnce('seed-stream-status-raw-text', () => {
  db.exec('update stream_status set raw_text = text');
});

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

// Identity, backfilled lazily from Helix the first time a login is seen without it.
// A row with message_count = 0 is a *lurker*: present in the channel, never typed.
// Nothing here is `not null` — an existing row predates every one of these columns,
// and a lurker legitimately has no profile until the backfill runs.
addColumnIfMissing('chatters', 'twitch_user_id', 'text');
addColumnIfMissing('chatters', 'display_name', 'text');
addColumnIfMissing('chatters', 'profile_image_url', 'text');
addColumnIfMissing('chatters', 'account_created_at', 'text');
addColumnIfMissing('chatters', 'last_seen_at', 'text');
addColumnIfMissing('chatters', 'profile_fetched_at', 'text');
addColumnIfMissing('chatters', 'missing_at', 'text');
db.exec('create index if not exists idx_chatters_user_id on chatters(twitch_user_id)');

// Logins the operator has flushed. This is what makes a flush stick: deleting the
// chatters row alone is self-healing-hostile, because the bot's next chat message
// recreates it immediately via upsertChatter.
db.exec(`
  create table if not exists ignored_logins (
    login text primary key,
    reason text not null default '',
    created_at text not null
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
