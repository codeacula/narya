import type { MediaPlayback, RewardMedia } from '../shared/api';
import { broadcast } from './realtime';

/**
 * The `media:play` broadcast.
 *
 * Reward media used to be a table of reward → file bindings read straight from the
 * redemption handler. That is now a `play_media` step on an Action fired by a reward
 * trigger, so the only thing left here is the broadcast itself. The `reward_media`
 * table is retained but no longer read at runtime — see legacyMigration.ts.
 *
 * The caller is responsible for having resolved the media through the configured
 * catalog (`resolveMediaAssetForPlayback`), which is what guarantees a disabled,
 * missing, or unconfigured asset never reaches the overlay.
 */
export function playMedia(media: RewardMedia, actor?: string): MediaPlayback {
  const payload: MediaPlayback = { id: crypto.randomUUID(), ...media, ...(actor ? { actor } : {}) };
  broadcast('media:play', payload);
  return payload;
}
