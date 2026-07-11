import { beforeEach, describe, expect, test } from 'bun:test';
import { db } from './db';
import { migrateLegacyMediaIntoAssets } from './legacyMigration';

type AssetRow = { id: string; label: string; kind: string; sourceType: string; src: string; volume: number; enabled: number };

function assets(): AssetRow[] {
  return db.prepare(`
    select id, label, kind, source_type as sourceType, src, volume, enabled
    from media_assets order by src
  `).all() as AssetRow[];
}

function assetBySrc(src: string): AssetRow | undefined {
  return assets().find(asset => asset.src === src);
}

beforeEach(() => {
  for (const table of ['media_assets', 'sound_buttons', 'clip_buttons', 'reward_media', 'alert_settings']) {
    db.exec(`delete from ${table}`);
  }
  db.exec("delete from schema_migrations where id = '2026-07-media-assets-from-legacy'");
});

describe('migrateLegacyMediaIntoAssets', () => {
  test('preserves sound and clip button ids, so anything already bound to one still resolves', () => {
    db.prepare('insert into sound_buttons (id, label, filename) values (?, ?, ?)').run('quack-1', 'Quack 1', '/sounds/quack.mp3');
    db.prepare('insert into clip_buttons (id, label, filename) values (?, ?, ?)').run('clip-abc', 'Dinosaur', '/clips/dinosaur.mp4');

    migrateLegacyMediaIntoAssets();

    expect(assetBySrc('/sounds/quack.mp3')?.id).toBe('quack-1');
    expect(assetBySrc('/clips/dinosaur.mp4')?.id).toBe('clip-abc');
  });

  test('infers kind and source type from the src', () => {
    db.prepare('insert into sound_buttons (id, label, filename) values (?, ?, ?)').run('s1', 'Local', '/sounds/a.mp3');
    db.prepare('insert into sound_buttons (id, label, filename) values (?, ?, ?)').run('s2', 'Remote', 'https://example.com/b.mp3');
    db.prepare('insert into clip_buttons (id, label, filename) values (?, ?, ?)').run('c1', 'Clip', '/clips/c.mp4');

    migrateLegacyMediaIntoAssets();

    expect(assetBySrc('/sounds/a.mp3')).toMatchObject({ kind: 'audio', sourceType: 'local' });
    expect(assetBySrc('https://example.com/b.mp3')).toMatchObject({ kind: 'audio', sourceType: 'remote' });
    expect(assetBySrc('/clips/c.mp4')).toMatchObject({ kind: 'video', sourceType: 'local' });
  });

  test('a legacy src whose file is gone becomes a disabled asset rather than being dropped', () => {
    db.prepare('insert into sound_buttons (id, label, filename) values (?, ?, ?)').run('gone', 'Missing', '/sounds/not-on-disk.mp3');

    migrateLegacyMediaIntoAssets();

    const asset = assetBySrc('/sounds/not-on-disk.mp3');
    expect(asset).toBeDefined();
    // Kept (so its label and any binding survive) but disabled, so it is visibly
    // broken instead of a reward that silently plays nothing.
    expect(asset?.enabled).toBe(0);
    expect(asset?.label).toBe('Missing');
  });

  test('deduplicates by src: a reward bound to a button-owned file reuses that asset', () => {
    db.prepare('insert into sound_buttons (id, label, filename) values (?, ?, ?)').run('shared', 'Shared', '/sounds/shared.mp3');
    db.prepare('insert into reward_media (reward_id, kind, src, volume, updated_at) values (?, ?, ?, ?, ?)')
      .run('reward-1', 'audio', '/sounds/shared.mp3', 0.5, '');

    migrateLegacyMediaIntoAssets();

    expect(assets().filter(asset => asset.src === '/sounds/shared.mp3')).toHaveLength(1);
    expect(assetBySrc('/sounds/shared.mp3')?.id).toBe('shared');
  });

  test('imports alert sound and clip effects', () => {
    db.prepare(`
      insert into alert_settings (kind, enabled, template, duration_ms, sound_src, sound_volume, clip_src, clip_volume, updated_at)
      values ('sub', 1, '', 6000, '/sounds/alert.mp3', 0.6, '/clips/alert.mp4', 0.7, '')
    `).run();

    migrateLegacyMediaIntoAssets();

    expect(assetBySrc('/sounds/alert.mp3')).toMatchObject({ kind: 'audio', volume: 0.6 });
    expect(assetBySrc('/clips/alert.mp4')).toMatchObject({ kind: 'video', volume: 0.7 });
  });

  test('is idempotent: a second run adds nothing and does not duplicate the operator Actions', () => {
    db.prepare('insert into sound_buttons (id, label, filename) values (?, ?, ?)').run('s1', 'One', '/sounds/a.mp3');
    db.prepare('insert into reward_media (reward_id, kind, src, volume, updated_at) values (?, ?, ?, ?, ?)')
      .run('r1', 'video', '/clips/b.mp4', 0.8, '');

    migrateLegacyMediaIntoAssets();
    const first = assets();
    migrateLegacyMediaIntoAssets();

    expect(assets()).toEqual(first);
  });
});
