import type express from 'express';
import type {
  DiscoveredMediaResponse,
  MediaAsset,
  MediaAssetInput,
  MediaAssetsResponse,
  MediaKind,
  MediaSourceType,
  PlayMediaPayload,
} from '../shared/api';
import { db } from './db';
import { handle, HttpRouteError, parseJsonColumn } from './http';
import { findMediaFile, listMediaFiles } from './media';
import { clampFinite } from './numeric';

const DEFAULT_VOLUME = 0.8;

/** The row as stored. `enabled` is SQLite's 0/1; `available` is never persisted. */
type MediaAssetRow = {
  id: string;
  label: string;
  kind: MediaKind;
  sourceType: MediaSourceType;
  src: string;
  volume: number;
  enabled: number;
  createdAt: string;
  updatedAt: string;
};

const COLUMNS = `
  id, label, kind, source_type as sourceType, src, volume, enabled,
  created_at as createdAt, updated_at as updatedAt
`;

const selectAllAssets = db.prepare(`select ${COLUMNS} from media_assets`);
const selectAsset = db.prepare(`select ${COLUMNS} from media_assets where id = ?`);
const insertAsset = db.prepare(`
  insert into media_assets (id, label, kind, source_type, src, volume, enabled, created_at, updated_at)
  values (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const updateAssetRow = db.prepare(`
  update media_assets
  set label = ?, kind = ?, source_type = ?, src = ?, volume = ?, enabled = ?, updated_at = ?
  where id = ?
`);
const deleteAssetRow = db.prepare('delete from media_assets where id = ?');
const selectPlayMediaSteps = db.prepare(
  "select payload_json as payloadJson from action_steps where step_type = 'play_media'",
);

/**
 * Derived, never stored: a local asset is playable only while its file is still
 * in the scan of public/. Remote assets are always considered available — we
 * don't reach out to the host to find out.
 */
function isAvailable(sourceType: MediaSourceType, src: string): boolean {
  return sourceType === 'remote' || findMediaFile(src) !== null;
}

function toAsset(row: MediaAssetRow): MediaAsset {
  return {
    id: row.id,
    label: row.label,
    kind: row.kind,
    sourceType: row.sourceType,
    src: row.src,
    volume: row.volume,
    enabled: row.enabled !== 0,
    available: isAvailable(row.sourceType, row.src),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function clampVolume(value: unknown): number {
  return typeof value === 'number' ? clampFinite(value, 0, 1, DEFAULT_VOLUME) : DEFAULT_VOLUME;
}

/**
 * A local src must resolve through the scan in media.ts — the security boundary.
 * Bindings are checked against the files we actually serve rather than
 * pattern-matched, so traversal and off-site srcs fail by simply not being there.
 *
 * `current` is the row being updated. If its file has since been deleted from
 * public/, re-saving that same src is still allowed: otherwise a broken entry
 * could never be renamed, disabled, or repaired.
 */
function validateLocal(src: string, declaredKind: MediaKind, current: MediaAssetRow | null): MediaKind {
  const file = findMediaFile(src);
  if (!file) {
    if (current && current.sourceType === 'local' && current.src === src) {
      if (declaredKind !== current.kind) {
        throw new HttpRouteError(400, `${src} is missing, so its kind cannot be changed to ${declaredKind}.`);
      }
      return current.kind;
    }
    throw new HttpRouteError(400, `Unknown media file: ${src}. Add it under public/clips or public/sounds.`);
  }
  // file.kind is the scan's mediaKindForPath result. The overlay picks <video> vs
  // <audio> from the stored kind, so a mismatch would play an mp3 in a video element.
  if (declaredKind !== file.kind) {
    throw new HttpRouteError(400, `${src} is ${file.kind}, not ${declaredKind}.`);
  }
  return file.kind;
}

/** Remote srcs are never resolved against the filesystem, so only http(s) is accepted. */
function validateRemote(src: string): void {
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    throw new HttpRouteError(400, `${src} is not a valid URL.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HttpRouteError(400, 'A remote source must be an http:// or https:// URL.');
  }
}

/** Absent fields fall back to the row being updated, so PUT accepts partial bodies. */
function normalize(body: unknown, current: MediaAssetRow | null): MediaAssetInput {
  const value = (body ?? {}) as Partial<MediaAssetInput>;

  const rawLabel = value.label === undefined ? current?.label ?? '' : value.label;
  const label = typeof rawLabel === 'string' ? rawLabel.trim() : '';
  if (!label) throw new HttpRouteError(400, 'A label is required.');

  const sourceType = value.sourceType === undefined ? current?.sourceType : value.sourceType;
  if (sourceType !== 'local' && sourceType !== 'remote') {
    throw new HttpRouteError(400, 'Source type must be "local" or "remote".');
  }

  const rawSrc = value.src === undefined ? current?.src ?? '' : value.src;
  const src = typeof rawSrc === 'string' ? rawSrc.trim() : '';
  if (!src) throw new HttpRouteError(400, 'A media file or URL is required.');

  const declaredKind = value.kind === undefined ? current?.kind : value.kind;
  if (declaredKind !== 'audio' && declaredKind !== 'video') {
    throw new HttpRouteError(400, 'Media kind must be "video" or "audio".');
  }

  // Local kind comes from the file on disk, not the client.
  const kind = sourceType === 'local' ? validateLocal(src, declaredKind, current) : declaredKind;
  if (sourceType === 'remote') validateRemote(src);

  const volume = value.volume === undefined && current ? current.volume : clampVolume(value.volume);
  const enabled = value.enabled === undefined
    ? (current ? current.enabled !== 0 : true)
    : Boolean(value.enabled);

  return { label, kind, sourceType, src, volume, enabled };
}

function requireRow(id: string): MediaAssetRow {
  const row = selectAsset.get(id) as MediaAssetRow | null;
  if (!row) throw new HttpRouteError(404, 'Unknown media asset.');
  return row;
}

/**
 * True when a play_media step still names this asset. The payload is parsed
 * rather than substring-matched so a step referencing a different id can't be
 * mistaken for a reference to this one.
 */
function isReferencedByAction(id: string): boolean {
  const rows = selectPlayMediaSteps.all() as Array<{ payloadJson: string }>;
  return rows.some(row => {
    const payload = parseJsonColumn<PlayMediaPayload>(row.payloadJson);
    return Array.isArray(payload?.assetIds) && payload.assetIds.includes(id);
  });
}

export function listMediaAssets(): MediaAsset[] {
  const rows = selectAllAssets.all() as MediaAssetRow[];
  return rows.map(toAsset).sort((a, b) => a.label.localeCompare(b.label));
}

export function findMediaAsset(id: string): MediaAsset | null {
  const row = selectAsset.get(id) as MediaAssetRow | null;
  return row ? toAsset(row) : null;
}

export function createMediaAsset(body: unknown): MediaAsset {
  const input = normalize(body, null);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  insertAsset.run(id, input.label, input.kind, input.sourceType, input.src, input.volume, input.enabled ? 1 : 0, now, now);
  return toAsset({ ...input, id, enabled: input.enabled ? 1 : 0, createdAt: now, updatedAt: now });
}

export function updateMediaAsset(id: string, body: unknown): MediaAsset {
  const current = requireRow(id);
  const input = normalize(body, current);
  const now = new Date().toISOString();
  updateAssetRow.run(input.label, input.kind, input.sourceType, input.src, input.volume, input.enabled ? 1 : 0, now, id);
  return toAsset({ ...current, ...input, enabled: input.enabled ? 1 : 0, updatedAt: now });
}

/**
 * Hard-deleting an asset an Action still plays would leave the step pointing at
 * an id that no longer resolves, so a referenced asset must be disabled instead.
 */
export function deleteMediaAsset(id: string): void {
  requireRow(id);
  if (isReferencedByAction(id)) {
    throw new HttpRouteError(409, 'This asset is used by an Action. Disable it instead of deleting it.');
  }
  deleteAssetRow.run(id);
}

/**
 * The single choke point for playback. Every path that would emit a media event
 * resolves the asset here first, so a disabled asset or one whose file has gone
 * missing can never reach the overlay.
 */
export function resolveMediaAssetForPlayback(id: string): MediaAsset | null {
  const asset = findMediaAsset(id);
  if (!asset || !asset.enabled || !asset.available) return null;
  return asset;
}

export function registerMediaAssetRoutes(app: express.Express) {
  app.get('/api/media-assets', handle((_req, res) => {
    const body: MediaAssetsResponse = { assets: listMediaAssets() };
    res.json(body);
  }));

  app.post('/api/media-assets', handle((req, res) => {
    res.status(201).json(createMediaAsset(req.body));
  }));

  app.put('/api/media-assets/:id', handle((req, res) => {
    res.json(updateMediaAsset(req.params.id, req.body));
  }));

  app.delete('/api/media-assets/:id', handle((req, res) => {
    deleteMediaAsset(req.params.id);
    res.status(204).end();
  }));

  // The only surface that exposes raw filesystem entries. `configuredSrcs` lets
  // the picker mark files that a configured asset already claims.
  app.get('/api/media/discovered', handle((_req, res) => {
    const configuredSrcs = listMediaAssets()
      .filter(asset => asset.sourceType === 'local')
      .map(asset => asset.src);
    const body: DiscoveredMediaResponse = {
      files: listMediaFiles(),
      configuredSrcs: [...new Set(configuredSrcs)],
    };
    res.json(body);
  }));
}
