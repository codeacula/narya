import type { MediaKind, MediaPlayback, RewardMedia } from '../shared/api';
import { db } from './db';
import { HttpRouteError } from './http';
import { findMediaFile } from './media';
import { broadcast } from './realtime';

const DEFAULT_VOLUME = 0.8;

const selectRewardMedia = db.prepare('select kind, src, volume from reward_media where reward_id = ?');
const selectAllRewardMedia = db.prepare('select reward_id as rewardId, kind, src, volume from reward_media');
const upsertRewardMedia = db.prepare(`
  insert into reward_media (reward_id, kind, src, volume, updated_at)
  values (?, ?, ?, ?, ?)
  on conflict(reward_id) do update set
    kind = excluded.kind,
    src = excluded.src,
    volume = excluded.volume,
    updated_at = excluded.updated_at
`);
const deleteRewardMediaRow = db.prepare('delete from reward_media where reward_id = ?');

function clampVolume(value: unknown): number {
  const volume = typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_VOLUME;
  return Math.max(0, Math.min(1, volume));
}

/** Validate a client-supplied binding against the media we actually serve. */
export function normalizeRewardMedia(body: unknown): RewardMedia {
  const value = body as Partial<RewardMedia>;
  const src = typeof value.src === 'string' ? value.src.trim() : '';
  if (!src) throw new HttpRouteError(400, 'A media file is required.');
  const file = findMediaFile(src);
  if (!file) {
    throw new HttpRouteError(400, `Unknown media file: ${src}. Add it under public/clips or public/sounds.`);
  }
  if (value.kind !== 'video' && value.kind !== 'audio') {
    throw new HttpRouteError(400, 'Media kind must be "video" or "audio".');
  }
  // The overlay picks <video> vs <audio> from the stored kind, so a mismatch
  // would play an mp3 in a video element — invisible, or silently broken.
  if (value.kind !== file.kind) {
    throw new HttpRouteError(400, `${src} is ${file.kind}, not ${value.kind}.`);
  }
  return { kind: file.kind as MediaKind, src, volume: clampVolume(value.volume) };
}

export function getRewardMedia(rewardId: string): RewardMedia | null {
  return (selectRewardMedia.get(rewardId) as RewardMedia | null) ?? null;
}

export function listRewardMedia(): Map<string, RewardMedia> {
  const rows = selectAllRewardMedia.all() as Array<RewardMedia & { rewardId: string }>;
  return new Map(rows.map(row => [row.rewardId, { kind: row.kind, src: row.src, volume: row.volume }]));
}

/** Pass null to clear the binding. */
export function setRewardMedia(rewardId: string, media: unknown): RewardMedia | null {
  if (media === null) {
    deleteRewardMediaRow.run(rewardId);
    return null;
  }
  const normalized = normalizeRewardMedia(media);
  upsertRewardMedia.run(rewardId, normalized.kind, normalized.src, normalized.volume, new Date().toISOString());
  return normalized;
}

export function deleteRewardMedia(rewardId: string): void {
  deleteRewardMediaRow.run(rewardId);
}

/**
 * Broadcast a reward's media to the /overlay/clips browser source, the only
 * listener for media:play. Returns null when the reward has no binding, so the
 * caller can 404 or simply do nothing.
 */
export function playRewardMedia(rewardId: string, actor?: string): MediaPlayback | null {
  const media = getRewardMedia(rewardId);
  if (!media) return null;
  const payload: MediaPlayback = { id: crypto.randomUUID(), ...media, ...(actor ? { actor } : {}) };
  broadcast('media:play', payload);
  return payload;
}
