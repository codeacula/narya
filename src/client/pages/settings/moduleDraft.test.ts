import { describe, expect, test } from 'bun:test';
import type { CategoryModuleInput } from '../../../shared/api';
import { moduleDraftDirty } from './moduleDraft';

const saved: CategoryModuleInput = {
  name: 'Minecraft',
  enabled: true,
  games: [{ id: '27471', name: 'Minecraft' }, { id: '509658', name: 'Just Chatting' }],
  rewardGroupIds: ['group-a', 'group-b'],
};

describe('moduleDraftDirty', () => {
  test('unticking and re-ticking a reward group is not an edit', () => {
    // The editor appends a re-ticked group, so the same set comes back reordered.
    const retick = { ...saved, rewardGroupIds: ['group-b', 'group-a'] };
    expect(moduleDraftDirty(retick, saved)).toBe(false);
  });

  test('removing a category and adding it back is not an edit', () => {
    const readded = { ...saved, games: [saved.games[1]!, saved.games[0]!] };
    expect(moduleDraftDirty(readded, saved)).toBe(false);
  });

  test('a different set still is', () => {
    expect(moduleDraftDirty({ ...saved, rewardGroupIds: ['group-a'] }, saved)).toBe(true);
    expect(moduleDraftDirty({ ...saved, games: [saved.games[0]!] }, saved)).toBe(true);
    expect(moduleDraftDirty({ ...saved, name: 'Minecraft 2' }, saved)).toBe(true);
  });

  test('no open draft is clean, and the inputs are not reordered in place', () => {
    expect(moduleDraftDirty(null, saved)).toBe(false);
    const draft = { ...saved, rewardGroupIds: ['group-b', 'group-a'] };
    moduleDraftDirty(draft, saved);
    expect(draft.rewardGroupIds).toEqual(['group-b', 'group-a']);
  });
});
