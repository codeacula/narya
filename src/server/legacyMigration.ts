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
