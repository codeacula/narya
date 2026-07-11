import type { MediaKind, MediaSourceType } from '../shared/api';
import { db, runOnce } from './db';
import { findMediaFile, mediaKindForPath } from './media';

/**
 * One-shot conversions from the pre-automation schema into the new one.
 *
 * Every migration here runs inside `runOnce`, which shares a transaction with the
 * ledger write: deriving rows from other rows is not idempotent, and a half-applied
 * conversion that re-ran on the next boot would duplicate the operator's Actions.
 *
 * The legacy tables are deliberately left intact. Nothing reads them at runtime
 * afterwards, but keeping them makes a bad migration inspectable rather than
 * unrecoverable.
 */

const insertAsset = db.prepare(`
  insert or ignore into media_assets (id, label, kind, source_type, src, volume, enabled, created_at, updated_at)
  values (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const assetIdBySrc = db.prepare('select id from media_assets where src = ?');

function isRemote(src: string): boolean {
  return /^https?:\/\//i.test(src);
}

/**
 * A legacy src whose file is no longer on disk still becomes an asset — deleting
 * it would lose the operator's label and silently unbind whatever referenced it.
 * It lands disabled so it is visibly broken and repairable, rather than a reward
 * that quietly plays nothing.
 */
function importAsset(
  id: string,
  label: string,
  src: string,
  fallbackKind: MediaKind,
  volume: number,
  now: string,
): string {
  const existing = assetIdBySrc.get(src) as { id: string } | null;
  if (existing) return existing.id;

  const sourceType: MediaSourceType = isRemote(src) ? 'remote' : 'local';
  const kind = mediaKindForPath(src) ?? fallbackKind;
  const available = sourceType === 'remote' || findMediaFile(src) !== null;
  insertAsset.run(id, label, kind, sourceType, src, volume, available ? 1 : 0, now, now);
  return id;
}

function labelFromSrc(src: string): string {
  const base = src.split('/').pop() ?? src;
  return base.replace(/\.[^.]+$/, '') || src;
}

/**
 * Sound and clip buttons keep their ids, so anything already pointing at a button
 * id (the tablet, chatbot `sound_play` steps) still resolves after the cutover.
 * Reward and alert media have no ids of their own — they are bare srcs — so they
 * are deduplicated by src against whatever the buttons already claimed.
 */
export function migrateLegacyMediaIntoAssets(): void {
  runOnce('2026-07-media-assets-from-legacy', () => {
    const now = new Date().toISOString();

    for (const row of db.prepare('select id, label, filename from sound_buttons').all() as Array<{ id: string; label: string; filename: string }>) {
      importAsset(row.id, row.label, row.filename, 'audio', 0.8, now);
    }
    for (const row of db.prepare('select id, label, filename from clip_buttons').all() as Array<{ id: string; label: string; filename: string }>) {
      importAsset(row.id, row.label, row.filename, 'video', 0.8, now);
    }
    for (const row of db.prepare('select src, kind, volume from reward_media').all() as Array<{ src: string; kind: MediaKind; volume: number }>) {
      importAsset(crypto.randomUUID(), labelFromSrc(row.src), row.src, row.kind, row.volume ?? 0.8, now);
    }
    for (const row of db.prepare('select sound_src, sound_volume, clip_src, clip_volume from alert_settings').all() as Array<{
      sound_src: string | null; sound_volume: number | null; clip_src: string | null; clip_volume: number | null;
    }>) {
      if (row.sound_src) importAsset(crypto.randomUUID(), labelFromSrc(row.sound_src), row.sound_src, 'audio', row.sound_volume ?? 0.8, now);
      if (row.clip_src) importAsset(crypto.randomUUID(), labelFromSrc(row.clip_src), row.clip_src, 'video', row.clip_volume ?? 0.8, now);
    }
  });
}

const insertAction = db.prepare(`
  insert into actions (id, name, description, enabled, created_at, updated_at) values (?, ?, ?, ?, ?, ?)
`);
const insertActionStep = db.prepare(`
  insert into action_steps (id, action_id, step_type, payload_json, delay_ms, enabled, position, created_at, updated_at)
  values (?, ?, ?, ?, 0, ?, ?, ?, ?)
`);
const insertTrigger = db.prepare(`
  insert into automation_triggers
    (id, kind, action_id, module_id, enabled, config_json, global_cooldown_ms, user_cooldown_ms, created_at, updated_at)
  values (?, ?, ?, null, ?, ?, 0, 0, ?, ?)
`);

/**
 * The old chat_reply renderer only understood {username}. The Action renderer calls
 * the same thing {actor}, so rewrite it — otherwise every migrated reply would print
 * the literal "{username}" (an unknown token is deliberately left intact).
 */
function convertLegacyTemplate(template: string): string {
  return template.replaceAll('{username}', '{actor}');
}

type LegacyActionRow = { actionType: string; payloadJson: string; enabled: number; position: number };

function legacyStepPayload(row: LegacyActionRow): { type: string; payload: unknown } | null {
  let payload: { template?: string; soundId?: string; sceneName?: string };
  try {
    payload = JSON.parse(row.payloadJson) as typeof payload;
  } catch {
    payload = {};
  }

  switch (row.actionType) {
    case 'chat_reply':
      if (!payload.template) return null;
      return { type: 'send_chat', payload: { template: convertLegacyTemplate(payload.template), sender: 'bot' } };
    case 'llm_response':
      // The old !ponder path fed everything after the trigger word to the LLM.
      return { type: 'llm_response', payload: { template: '{input}' } };
    case 'sound_play':
      if (!payload.soundId) return null;
      // Sound-button ids survive as media-asset ids (see migrateLegacyMediaIntoAssets),
      // so an existing binding keeps resolving without being re-pointed by hand.
      return { type: 'play_media', payload: { assetIds: [payload.soundId], selection: 'first' } };
    case 'obs_scene':
      if (!payload.sceneName) return null;
      return { type: 'obs_scene', payload: { sceneName: payload.sceneName } };
    case 'obs_transition':
      return { type: 'obs_transition', payload: {} };
    default:
      return null;
  }
}

/**
 * Each chatbot command becomes one Action plus one `viewer_command` trigger, so it is
 * editable in the same place as everything else instead of living in its own table.
 *
 * Cooldowns are zero, matching the old handler, which had none — introducing one here
 * would silently start swallowing a viewer's second `!lurk`.
 */
export function migrateLegacyChatbotCommands(): void {
  runOnce('2026-07-actions-from-chatbot-commands', () => {
    const now = new Date().toISOString();
    const commands = db.prepare('select id, trigger, enabled from chatbot_commands').all() as Array<{
      id: string; trigger: string; enabled: number;
    }>;

    for (const command of commands) {
      const legacySteps = db.prepare(`
        select action_type as actionType, payload_json as payloadJson, enabled, position
        from chatbot_command_actions where command_id = ? order by position asc
      `).all(command.id) as LegacyActionRow[];

      const steps = legacySteps
        .map(row => ({ row, converted: legacyStepPayload(row) }))
        .filter((entry): entry is { row: LegacyActionRow; converted: { type: string; payload: unknown } } => entry.converted !== null);
      if (steps.length === 0) continue;

      const actionId = crypto.randomUUID();
      insertAction.run(actionId, command.trigger, `Migrated from the ${command.trigger} chat command.`, 1, now, now);
      steps.forEach((entry, index) => {
        insertActionStep.run(
          crypto.randomUUID(), actionId, entry.converted.type, JSON.stringify(entry.converted.payload),
          entry.row.enabled ? 1 : 0, index, now, now,
        );
      });

      insertTrigger.run(
        crypto.randomUUID(), 'viewer_command', actionId, command.enabled ? 1 : 0,
        JSON.stringify({ command: command.trigger, aliases: [], roles: [] }), now, now,
      );
    }
  });
}

/** Names are unique in `actions`, and a migrated name can collide. Suffix rather than fail. */
function uniqueActionName(base: string): string {
  const exists = db.prepare('select 1 as present from actions where name = ?');
  if (!exists.get(base)) return base;
  for (let n = 2; n < 500; n += 1) {
    const candidate = `${base} (${n})`;
    if (!exists.get(candidate)) return candidate;
  }
  return `${base} (${crypto.randomUUID().slice(0, 8)})`;
}

const assetBySrcRow = db.prepare('select id, label from media_assets where src = ?');

/**
 * Reward media and TTS bindings become one Action per reward plus a `reward` trigger.
 *
 * Runs after the media migration, which already turned every reward src into an asset,
 * so a play_media step can bind the asset id rather than a raw path.
 *
 * Cooldowns are zero: the old redemption path had none, and Twitch already enforces
 * whatever per-reward cooldown the operator configured. Adding one here would silently
 * swallow a redeem the viewer paid points for.
 */
export function migrateLegacyRewardBindings(): void {
  runOnce('2026-07-actions-from-reward-bindings', () => {
    const now = new Date().toISOString();
    const media = db.prepare('select reward_id as rewardId, kind, src, volume from reward_media').all() as Array<{
      rewardId: string; kind: MediaKind; src: string; volume: number;
    }>;
    const ttsRewards = new Set(
      (db.prepare('select reward_id as rewardId from tts_reward_enabled').all() as Array<{ rewardId: string }>)
        .map(row => row.rewardId),
    );

    const rewardIds = new Set<string>([...media.map(row => row.rewardId), ...ttsRewards]);

    for (const rewardId of rewardIds) {
      const binding = media.find(row => row.rewardId === rewardId) ?? null;
      const asset = binding ? assetBySrcRow.get(binding.src) as { id: string; label: string } | null : null;

      const steps: Array<{ type: string; payload: unknown }> = [];
      if (binding && asset) {
        // Keep the reward's own volume: it overrode the asset's default before, and
        // the operator tuned it per reward (three of them sit at 1.0, not 0.8).
        steps.push({
          type: 'play_media',
          payload: { assetIds: [asset.id], selection: 'first', volume: binding.volume },
        });
      }
      if (ttsRewards.has(rewardId)) {
        // The old path spoke the redemption's user input, and only when it was non-empty.
        // An empty {input} renders empty, which the executor reports as a skipped step.
        steps.push({ type: 'tts_speak', payload: { template: '{input}' } });
      }
      if (steps.length === 0) continue;

      // The reward's Twitch title lives on Twitch, not here, so name from what we have.
      // The trigger editor resolves the real title for display anyway.
      const label = asset?.label ?? 'TTS';
      const actionId = crypto.randomUUID();
      insertAction.run(
        actionId,
        uniqueActionName(`Redeem: ${label}`),
        'Migrated from a channel-point reward binding.',
        1, now, now,
      );
      steps.forEach((step, index) => {
        insertActionStep.run(crypto.randomUUID(), actionId, step.type, JSON.stringify(step.payload), 1, index, now, now);
      });
      insertTrigger.run(
        crypto.randomUUID(), 'reward', actionId, 1,
        JSON.stringify({ rewardId }), now, now,
      );
    }
  });
}

/** The old alert renderer used {user}; the Action renderer calls that {actor}. */
function convertAlertTemplate(template: string): string {
  return template.replaceAll('{user}', '{actor}');
}

/** Mirrors ALERT_TONES in the alerts module this replaces, so colours survive. */
const ALERT_TONES: Record<string, string> = {
  sub: 'warning',
  gift: 'warning',
  cheer: 'info',
  raid: 'note',
  follow: 'silver',
};

/**
 * Each alert becomes an Action (overlay text plus its sound and/or clip) and a
 * `twitch_event` trigger.
 *
 * The sound and clip are separate steps at delay 0, so they start together rather
 * than one waiting out the other — the alert card played them simultaneously.
 * `{amount}`, `{tier}`, and `{months}` already exist in TemplateContext, so only
 * `{user}` needs rewriting.
 *
 * Disabled alerts still migrate, as a disabled trigger: the operator's wording and
 * media survive and can be switched back on, whereas dropping them would lose work.
 */
export function migrateLegacyAlerts(): void {
  runOnce('2026-07-actions-from-alerts', () => {
    const now = new Date().toISOString();
    const alerts = db.prepare(`
      select kind, enabled, template, duration_ms as durationMs,
             sound_src as soundSrc, sound_volume as soundVolume,
             clip_src as clipSrc, clip_volume as clipVolume
      from alert_settings
    `).all() as Array<{
      kind: string; enabled: number; template: string; durationMs: number;
      soundSrc: string | null; soundVolume: number | null;
      clipSrc: string | null; clipVolume: number | null;
    }>;

    for (const alert of alerts) {
      const steps: Array<{ type: string; payload: unknown }> = [];
      const template = convertAlertTemplate(alert.template ?? '');
      if (template.trim()) {
        steps.push({
          type: 'show_text',
          payload: {
            template,
            durationMs: alert.durationMs,
            style: 'banner',
            tone: ALERT_TONES[alert.kind] ?? 'info',
          },
        });
      }
      for (const [src, volume] of [[alert.soundSrc, alert.soundVolume], [alert.clipSrc, alert.clipVolume]] as const) {
        if (!src) continue;
        const asset = assetBySrcRow.get(src) as { id: string } | null;
        if (!asset) continue;
        steps.push({
          type: 'play_media',
          payload: { assetIds: [asset.id], selection: 'first', volume: volume ?? 0.8 },
        });
      }
      if (steps.length === 0) continue;

      const actionId = crypto.randomUUID();
      insertAction.run(
        actionId,
        uniqueActionName(`Alert: ${alert.kind}`),
        `Migrated from the ${alert.kind} alert.`,
        1, now, now,
      );
      steps.forEach((step, index) => {
        insertActionStep.run(crypto.randomUUID(), actionId, step.type, JSON.stringify(step.payload), 1, index, now, now);
      });
      insertTrigger.run(
        crypto.randomUUID(), 'twitch_event', actionId, alert.enabled ? 1 : 0,
        JSON.stringify({ eventKind: alert.kind }), now, now,
      );
    }
  });
}

const insertModule = db.prepare(`
  insert into category_modules (id, name, enabled, status, status_detail, created_at, updated_at)
  values (?, ?, 1, 'idle', '', ?, ?)
`);
const insertModuleGame = db.prepare(`
  insert or ignore into category_module_games (game_id, module_id, game_name, created_at) values (?, ?, ?, ?)
`);
const insertModuleGroup = db.prepare(`
  insert or ignore into category_module_reward_groups (module_id, group_id, created_at) values (?, ?, ?)
`);

/**
 * One generated module per Twitch game that already had reward groups mapped to it,
 * owning every group mapped to that game. This reproduces what
 * `applyRewardGroupsForStreamCategory` used to do, so the cutover is behaviour-preserving.
 *
 * The load-bearing detail is what is NOT migrated: a reward group with no game mapping
 * stays unowned by any module. The old auto-switch left unmapped groups alone, and a
 * module that owned one would start disabling it on every category change — silently
 * turning off an always-on group the operator never asked a module to manage.
 *
 * A group mapped to several games ends up owned by several generated modules. That is
 * allowed; only a *game* is restricted to one module, which the schema enforces.
 */
export function migrateLegacyCategoryModules(): void {
  runOnce('2026-07-category-modules-from-reward-groups', () => {
    const now = new Date().toISOString();
    const mappings = db.prepare(`
      select game_id as gameId, game_name as gameName, category_id as groupId
      from viewer_reward_category_games
    `).all() as Array<{ gameId: string; gameName: string; groupId: string }>;

    const groupsByGame = new Map<string, { gameName: string; groupIds: string[] }>();
    for (const row of mappings) {
      const entry = groupsByGame.get(row.gameId) ?? { gameName: row.gameName, groupIds: [] };
      entry.groupIds.push(row.groupId);
      groupsByGame.set(row.gameId, entry);
    }

    for (const [gameId, { gameName, groupIds }] of groupsByGame) {
      const moduleId = crypto.randomUUID();
      insertModule.run(moduleId, gameName, now, now);
      insertModuleGame.run(gameId, moduleId, gameName, now);
      for (const groupId of groupIds) insertModuleGroup.run(moduleId, groupId, now);
    }
  });
}
