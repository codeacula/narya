import type { ClipButton, ClipButtonUpdate, MediaPlayback } from '../shared/api';
import { db } from './db';
import { HttpRouteError } from './http';
import { findMediaFile } from './media';
import { playMedia } from './rewardMedia';

const listClipButtons = db.prepare(`
  select id, label, filename
  from clip_buttons
  order by label collate nocase
`);
const getClipButton = db.prepare(`
  select id, label, filename
  from clip_buttons
  where id = ?
`);
const createClipButtonRow = db.prepare(`
  insert into clip_buttons (id, label, filename)
  values (?, ?, ?)
`);
const updateClipButtonRow = db.prepare(`
  update clip_buttons
  set label = ?, filename = ?
  where id = ?
`);
const deleteClipButtonRow = db.prepare('delete from clip_buttons where id = ?');

export function getClipButtons(): ClipButton[] {
  return listClipButtons.all() as ClipButton[];
}

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

export function createClipButton(body: unknown): ClipButton {
  const clip = normalizeClipButtonBody(body);
  const id = crypto.randomUUID();
  createClipButtonRow.run(id, clip.label, clip.filename);
  return getClipButton.get(id) as ClipButton;
}

export function updateClipButton(id: string, body: unknown): ClipButton {
  const existing = getClipButton.get(id) as ClipButton | null;
  if (!existing) throw new HttpRouteError(404, 'Clip button not found.');

  const clip = normalizeClipButtonBody(body);
  updateClipButtonRow.run(clip.label, clip.filename, id);
  return getClipButton.get(id) as ClipButton;
}

export function deleteClipButton(id: string) {
  const existing = getClipButton.get(id) as ClipButton | null;
  if (!existing) throw new HttpRouteError(404, 'Clip button not found.');
  deleteClipButtonRow.run(id);
}

/**
 * Broadcast the clip to the /overlay/clips browser source, the same path a
 * channel-point redeem takes. Returns null when the button is gone or its file
 * no longer exists, so the route can 404.
 */
export function triggerClipButton(id: string): MediaPlayback | null {
  const clip = getClipButton.get(id) as ClipButton | null;
  if (!clip) return null;
  const media = findMediaFile(clip.filename);
  if (!media) return null;
  return playMedia({ kind: media.kind, src: clip.filename, volume: 1 });
}
