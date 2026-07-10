import { beforeEach, describe, expect, test } from 'bun:test';
import { db } from './db';
import {
  deleteSavedStreamCategory,
  listSavedStreamCategories,
  setSavedStreamCategoryTags,
} from './streamCategories';

function seedCategory(id: string, name: string) {
  db.prepare('insert or replace into stream_categories (game_id, game_name, box_art_url, hidden, created_at) values (?, ?, null, 0, ?)')
    .run(id, name, new Date().toISOString());
}

describe('saved stream category tags', () => {
  beforeEach(() => {
    db.exec('delete from stream_category_tags');
    db.exec('delete from stream_categories');
    db.exec('delete from stream_tag_history');
  });

  test('setting tags replaces the prior set and records history', () => {
    seedCategory('111', 'Test Game');
    setSavedStreamCategoryTags('111', ['Cozy', 'Chill']);
    setSavedStreamCategoryTags('111', ['Speedrun']);
    const cat = listSavedStreamCategories().find(c => c.id === '111');
    expect(cat?.tags).toEqual(['Speedrun']);
  });

  test('tags are normalized and deduped', () => {
    seedCategory('222', 'Another');
    setSavedStreamCategoryTags('222', ['#Cozy', 'cozy', 'Chill!']);
    const cat = listSavedStreamCategories().find(c => c.id === '222');
    expect(cat?.tags).toEqual(['Cozy', 'Chill']);
  });

  test('deleting a saved category removes it and its tags', () => {
    seedCategory('333', 'Gone');
    setSavedStreamCategoryTags('333', ['Tag']);
    deleteSavedStreamCategory('333');
    expect(listSavedStreamCategories().some(c => c.id === '333')).toBe(false);
    expect(db.prepare('select count(*) as n from stream_category_tags where game_id = ?').get('333'))
      .toEqual({ n: 0 });
  });

  test('rewardGroups reflect viewer_reward_category_games mappings', () => {
    seedCategory('444', 'Mapped Game');
    db.prepare('insert or replace into viewer_reward_categories (id, name, enabled, created_at, updated_at) values (?, ?, 1, ?, ?)')
      .run('grp1', 'Combat Rewards', new Date().toISOString(), new Date().toISOString());
    db.prepare('insert or replace into viewer_reward_category_games (category_id, game_id, game_name, created_at) values (?, ?, ?, ?)')
      .run('grp1', '444', 'Mapped Game', new Date().toISOString());
    const cat = listSavedStreamCategories().find(c => c.id === '444');
    expect(cat?.rewardGroups).toEqual([{ id: 'grp1', name: 'Combat Rewards' }]);
  });
});
