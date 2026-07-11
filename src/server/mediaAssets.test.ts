import { beforeEach, describe, expect, test } from 'bun:test';
import { db } from './db';
import { HttpRouteError } from './http';
import { listMediaFiles } from './media';
import {
  createMediaAsset,
  deleteMediaAsset,
  findMediaAsset,
  listMediaAssets,
  resolveMediaAssetForPlayback,
  updateMediaAsset,
} from './mediaAssets';

const KNOWN_AUDIO = listMediaFiles().find(file => file.kind === 'audio')?.src ?? '';
// public/clips is gitignored, so a clean checkout has no video to test against.
const KNOWN_VIDEO = listMediaFiles().find(file => file.kind === 'video')?.src ?? '';

const audioInput = (over: Record<string, unknown> = {}) => ({
  label: 'Quack',
  kind: 'audio',
  sourceType: 'local',
  src: KNOWN_AUDIO,
  volume: 0.5,
  enabled: true,
  ...over,
});

const remoteInput = (over: Record<string, unknown> = {}) => ({
  label: 'Remote horn',
  kind: 'audio',
  sourceType: 'remote',
  src: 'https://cdn.example/horn.mp3',
  volume: 0.5,
  enabled: true,
  ...over,
});

/** Writes a row straight past validation, to model a file deleted from public/. */
function insertRawAsset(id: string, over: Partial<Record<string, unknown>> = {}): void {
  const row = {
    label: 'Gone',
    kind: 'audio',
    source_type: 'local',
    src: '/sounds/deleted-by-the-operator.mp3',
    volume: 0.5,
    enabled: 1,
    ...over,
  };
  const now = new Date().toISOString();
  db.prepare(`
    insert into media_assets (id, label, kind, source_type, src, volume, enabled, created_at, updated_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, row.label, row.kind, row.source_type, row.src, row.volume, row.enabled, now, now);
}

function insertPlayMediaStep(stepId: string, assetIds: string[]): void {
  const now = new Date().toISOString();
  db.prepare(`
    insert into actions (id, name, description, enabled, created_at, updated_at)
    values (?, ?, '', 1, ?, ?)
  `).run(`action-for-${stepId}`, `action-for-${stepId}`, now, now);
  db.prepare(`
    insert into action_steps (id, action_id, step_type, payload_json, delay_ms, enabled, position, created_at, updated_at)
    values (?, ?, 'play_media', ?, 0, 1, 0, ?, ?)
  `).run(stepId, `action-for-${stepId}`, JSON.stringify({ assetIds, selection: 'first' }), now, now);
}

beforeEach(() => {
  db.exec('delete from action_steps');
  db.exec('delete from actions');
  db.exec('delete from media_assets');
});

describe('createMediaAsset validation', () => {
  test('accepts a local src the scan actually contains', () => {
    const asset = createMediaAsset(audioInput());
    expect(asset).toMatchObject({ label: 'Quack', kind: 'audio', sourceType: 'local', src: KNOWN_AUDIO });
    expect(asset.id).toBeTruthy();
    expect(asset.available).toBe(true);
  });

  // The scan in media.ts is the security boundary: a crafted path fails simply by
  // not being in it, so traversal and off-site srcs never reach the catalog.
  test('rejects a local src that is not in the scan', () => {
    expect(() => createMediaAsset(audioInput({ src: '/clips/../../.env' }))).toThrow(HttpRouteError);
    expect(() => createMediaAsset(audioInput({ src: '/etc/passwd' }))).toThrow(HttpRouteError);
    expect(() => createMediaAsset(audioInput({ src: '/sounds/never-existed.mp3' }))).toThrow(HttpRouteError);
    expect(() => createMediaAsset(audioInput({ src: 'https://evil.example/x.mp3' }))).toThrow(HttpRouteError);
    expect(() => createMediaAsset(audioInput({ src: '' }))).toThrow(HttpRouteError);
    expect(listMediaAssets()).toHaveLength(0);
  });

  test('rejects a declared kind that disagrees with the file on disk', () => {
    expect(() => createMediaAsset(audioInput({ kind: 'video' }))).toThrow(HttpRouteError);
    if (KNOWN_VIDEO) {
      expect(() => createMediaAsset(audioInput({ kind: 'audio', src: KNOWN_VIDEO }))).toThrow(HttpRouteError);
    }
    expect(listMediaAssets()).toHaveLength(0);
  });

  test('rejects an unknown kind and an unknown sourceType', () => {
    expect(() => createMediaAsset(audioInput({ kind: 'gif' }))).toThrow(HttpRouteError);
    expect(() => createMediaAsset(audioInput({ sourceType: 'ftp' }))).toThrow(HttpRouteError);
  });

  test('rejects a blank label', () => {
    expect(() => createMediaAsset(audioInput({ label: '   ' }))).toThrow(HttpRouteError);
  });

  test('accepts an http(s) remote url and treats it as always available', () => {
    const asset = createMediaAsset(remoteInput());
    expect(asset).toMatchObject({ sourceType: 'remote', src: 'https://cdn.example/horn.mp3', available: true });
    expect(createMediaAsset(remoteInput({ src: 'http://cdn.example/a.mp3' })).available).toBe(true);
  });

  // A remote src is never resolved against the filesystem, so anything but
  // http(s) would be a way to smuggle in a local path or a script url.
  test('rejects a remote src whose scheme is not http(s)', () => {
    expect(() => createMediaAsset(remoteInput({ src: 'file:///etc/passwd' }))).toThrow(HttpRouteError);
    expect(() => createMediaAsset(remoteInput({ src: 'javascript:alert(1)' }))).toThrow(HttpRouteError);
    expect(() => createMediaAsset(remoteInput({ src: 'data:audio/mp3;base64,AAAA' }))).toThrow(HttpRouteError);
    expect(() => createMediaAsset(remoteInput({ src: '/sounds/local.mp3' }))).toThrow(HttpRouteError);
    expect(() => createMediaAsset(remoteInput({ src: 'not a url' }))).toThrow(HttpRouteError);
    expect(listMediaAssets()).toHaveLength(0);
  });

  test('clamps volume into 0..1 and defaults when absent', () => {
    expect(createMediaAsset(audioInput({ volume: 9 })).volume).toBe(1);
    expect(createMediaAsset(audioInput({ volume: -3 })).volume).toBe(0);
    expect(createMediaAsset(audioInput({ volume: undefined })).volume).toBe(0.8);
    expect(createMediaAsset(audioInput({ volume: NaN })).volume).toBe(0.8);
  });
});

describe('availability is derived, never stored', () => {
  test('a local asset whose file vanished stays in the catalog but reports unavailable', () => {
    insertRawAsset('gone-1');
    const asset = findMediaAsset('gone-1');
    expect(asset).not.toBeNull();
    expect(asset?.available).toBe(false);
    // Still listed, so the operator can repair or delete it.
    expect(listMediaAssets().map(entry => entry.id)).toContain('gone-1');
  });

  test('a local asset backed by a real file reports available', () => {
    expect(createMediaAsset(audioInput()).available).toBe(true);
  });

  test('availability is not persisted as a column', () => {
    const columns = db.prepare('pragma table_info(media_assets)').all() as Array<{ name: string }>;
    expect(columns.map(column => column.name)).not.toContain('available');
  });
});

describe('updateMediaAsset', () => {
  test('applies a partial body and leaves absent fields alone', () => {
    const created = createMediaAsset(audioInput({ label: 'Before', volume: 0.5 }));
    const updated = updateMediaAsset(created.id, { label: 'After' });
    expect(updated).toMatchObject({ label: 'After', volume: 0.5, src: KNOWN_AUDIO });
  });

  test('can disable an asset without touching its src', () => {
    const created = createMediaAsset(audioInput());
    expect(updateMediaAsset(created.id, { enabled: false }).enabled).toBe(false);
  });

  // Repairing or disabling a broken asset must not be blocked by the very file
  // that is missing, or the catalog entry would be unfixable.
  test('a broken local asset can still be relabelled, disabled, and repaired', () => {
    insertRawAsset('gone-2');
    expect(updateMediaAsset('gone-2', { enabled: false }).available).toBe(false);
    expect(updateMediaAsset('gone-2', { label: 'Renamed' }).label).toBe('Renamed');
    const repaired = updateMediaAsset('gone-2', { src: KNOWN_AUDIO, kind: 'audio' });
    expect(repaired.available).toBe(true);
    expect(repaired.src).toBe(KNOWN_AUDIO);
  });

  test('still rejects an invalid new src on an existing asset', () => {
    const created = createMediaAsset(audioInput());
    expect(() => updateMediaAsset(created.id, { src: '/clips/../../.env' })).toThrow(HttpRouteError);
    expect(() => updateMediaAsset(created.id, { sourceType: 'remote', src: 'file:///etc/passwd' }))
      .toThrow(HttpRouteError);
    // The rejected write left the stored row untouched.
    expect(findMediaAsset(created.id)?.src).toBe(KNOWN_AUDIO);
  });

  test('rejects an unknown id', () => {
    expect(() => updateMediaAsset('nobody', { label: 'x' })).toThrow(HttpRouteError);
  });
});

describe('resolveMediaAssetForPlayback', () => {
  test('returns an enabled, available asset', () => {
    const created = createMediaAsset(audioInput());
    expect(resolveMediaAssetForPlayback(created.id)?.id).toBe(created.id);
  });

  // This is the choke point every playback path goes through, so a disabled or
  // missing asset can never reach the overlay.
  test('returns null for a disabled asset', () => {
    const created = createMediaAsset(audioInput({ enabled: false }));
    expect(resolveMediaAssetForPlayback(created.id)).toBeNull();
  });

  test('returns null for a local asset whose file is gone', () => {
    insertRawAsset('gone-3');
    expect(resolveMediaAssetForPlayback('gone-3')).toBeNull();
  });

  test('returns null for a disabled asset even when its file exists', () => {
    insertRawAsset('off-1', { src: KNOWN_AUDIO, enabled: 0 });
    expect(resolveMediaAssetForPlayback('off-1')).toBeNull();
  });

  test('returns null for an unknown id', () => {
    expect(resolveMediaAssetForPlayback('nobody')).toBeNull();
    expect(resolveMediaAssetForPlayback('')).toBeNull();
  });

  test('resolves an enabled remote asset without touching the filesystem', () => {
    const created = createMediaAsset(remoteInput());
    expect(resolveMediaAssetForPlayback(created.id)?.src).toBe('https://cdn.example/horn.mp3');
  });
});

describe('deleteMediaAsset', () => {
  test('removes an unreferenced asset', () => {
    const created = createMediaAsset(audioInput());
    deleteMediaAsset(created.id);
    expect(findMediaAsset(created.id)).toBeNull();
  });

  // Hard-deleting a referenced asset would leave an Action step pointing at an id
  // that no longer resolves; the operator disables it instead.
  test('refuses to delete an asset a play_media step still references', () => {
    const created = createMediaAsset(audioInput());
    insertPlayMediaStep('step-1', [created.id]);

    let thrown: unknown;
    try {
      deleteMediaAsset(created.id);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HttpRouteError);
    expect((thrown as HttpRouteError).status).toBe(409);
    expect(findMediaAsset(created.id)).not.toBeNull();
  });

  test('refuses when the asset is one of several ids on the step', () => {
    const created = createMediaAsset(audioInput());
    insertPlayMediaStep('step-2', ['other-asset', created.id]);
    expect(() => deleteMediaAsset(created.id)).toThrow(HttpRouteError);
  });

  test('allows deletion once the referencing step is gone', () => {
    const created = createMediaAsset(audioInput());
    insertPlayMediaStep('step-3', [created.id]);
    db.exec('delete from action_steps');
    deleteMediaAsset(created.id);
    expect(findMediaAsset(created.id)).toBeNull();
  });

  test('a step referencing a different asset does not block the delete', () => {
    const created = createMediaAsset(audioInput());
    insertPlayMediaStep('step-4', ['some-other-id']);
    deleteMediaAsset(created.id);
    expect(findMediaAsset(created.id)).toBeNull();
  });

  test('rejects an unknown id', () => {
    expect(() => deleteMediaAsset('nobody')).toThrow(HttpRouteError);
  });
});

describe('listMediaAssets', () => {
  test('returns every asset, broken ones included, sorted by label', () => {
    createMediaAsset(audioInput({ label: 'Zebra' }));
    createMediaAsset(audioInput({ label: 'Alpha' }));
    insertRawAsset('gone-4', { label: 'Missing' });
    expect(listMediaAssets().map(asset => asset.label)).toEqual(['Alpha', 'Missing', 'Zebra']);
  });

  test('is empty on a fresh catalog', () => {
    expect(listMediaAssets()).toEqual([]);
  });
});
