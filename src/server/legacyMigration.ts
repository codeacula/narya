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
