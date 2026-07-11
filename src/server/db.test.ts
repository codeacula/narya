import { afterEach, describe, expect, test } from 'bun:test';
import { db } from './db';

const NOW = '2026-07-11T00:00:00.000Z';

function countRows(table: string, categoryId: string): number {
  return (db
    .prepare(`select count(*) as count from ${table} where category_id = ?`)
    .get(categoryId) as { count: number }).count;
}

afterEach(() => {
  db.exec("delete from viewer_reward_categories where id like 'test-cat%'");
  db.exec("delete from viewer_reward_category_games where category_id like 'test-cat%'");
  db.exec("delete from viewer_reward_category_members where category_id like 'test-cat%'");
});

describe('foreign keys', () => {
  test('are enabled on the connection, so the declared cascades actually run', () => {
    const [row] = db.prepare('pragma foreign_keys').all() as Array<{ foreign_keys: number }>;
    expect(row.foreign_keys).toBe(1);
  });

  test('deleting a reward category cascades to its members and game mappings', () => {
    db.prepare(
      'insert into viewer_reward_categories (id, name, enabled, created_at, updated_at) values (?, ?, 1, ?, ?)',
    ).run('test-cat-1', 'Test Category', NOW, NOW);
    db.prepare(
      'insert into viewer_reward_category_members (reward_id, category_id, updated_at) values (?, ?, ?)',
    ).run('test-reward-1', 'test-cat-1', NOW);
    db.prepare(
      'insert into viewer_reward_category_games (category_id, game_id, game_name, created_at) values (?, ?, ?, ?)',
    ).run('test-cat-1', 'game-1', 'Some Game', NOW);

    expect(countRows('viewer_reward_category_members', 'test-cat-1')).toBe(1);
    expect(countRows('viewer_reward_category_games', 'test-cat-1')).toBe(1);

    db.prepare('delete from viewer_reward_categories where id = ?').run('test-cat-1');

    // The game mapping is the one that used to survive the delete and orphan.
    expect(countRows('viewer_reward_category_members', 'test-cat-1')).toBe(0);
    expect(countRows('viewer_reward_category_games', 'test-cat-1')).toBe(0);
  });

  test('a game mapping cannot reference a category that does not exist', () => {
    expect(() => {
      db.prepare(
        'insert into viewer_reward_category_games (category_id, game_id, game_name, created_at) values (?, ?, ?, ?)',
      ).run('test-cat-missing', 'game-2', 'Some Game', NOW);
    }).toThrow(/FOREIGN KEY constraint failed/i);
  });
});
