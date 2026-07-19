import type { ClipButton, ClipButtonUpdate, MediaPlayback } from '../shared/api';
import { HttpRouteError } from './http';
import { createLabeledButtonRepo } from './labeledButtons';
import { findMediaFile } from './media';
import { playMedia } from './rewardMedia';

function normalizeClipButtonBody(body: unknown): ClipButtonUpdate {
  const value = body as Partial<ClipButtonUpdate>;
  const label = typeof value.label === 'string' ? value.label.trim() : '';
  const filename = typeof value.filename === 'string' ? value.filename.trim() : '';

  if (!label) throw new HttpRouteError(400, 'Clip label is required.');
  if (label.length > 60) throw new HttpRouteError(400, 'Clip label must be 60 characters or fewer.');
  if (!filename) throw new HttpRouteError(400, 'Clip file is required.');

  // Bind only to a real video under public/clips. Validating against the scan
  // (rather than the raw string) also keeps a crafted path from escaping public/.
  const media = findMediaFile(filename);
  if (!media || media.kind !== 'video') {
    throw new HttpRouteError(400, 'Clip file must be an available video under public/clips.');
  }

  return { label, filename };
}

/**
 * Broadcast the clip to the /overlay/clips browser source, the same path a
 * channel-point redeem takes. Returns null when the button's file no longer
 * exists, so the route can 404.
 */
function playClipButton(clip: ClipButton): MediaPlayback | null {
  const media = findMediaFile(clip.filename);
  if (!media) return null;
  return playMedia({ kind: media.kind, src: clip.filename, volume: 1 });
}

const clipButtons = createLabeledButtonRepo<ClipButton, MediaPlayback>({
  table: 'clip_buttons',
  notFoundMessage: 'Clip button not found.',
  validate: normalizeClipButtonBody,
  play: playClipButton,
});

export function getClipButtons(): ClipButton[] {
  return clipButtons.list();
}

export function createClipButton(body: unknown): ClipButton {
  return clipButtons.create(body);
}

export function updateClipButton(id: string, body: unknown): ClipButton {
  return clipButtons.update(id, body);
}

export function deleteClipButton(id: string) {
  clipButtons.remove(id);
}

export function triggerClipButton(id: string): MediaPlayback | null {
  return clipButtons.trigger(id);
}
