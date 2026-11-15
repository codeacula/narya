import { describe, expect, test } from 'bun:test';
import {
  createDirtyRegistry,
  describeUnsaved,
  discardPrompt,
  draftIsDirty,
  draftsDiffer,
  stableStringify,
} from './dirtyGuardLogic';

describe('draftsDiffer', () => {
  test('equal values built in a different key order are not different', () => {
    expect(draftsDiffer({ a: 1, b: { c: 2, d: [1, 2] } }, { b: { d: [1, 2], c: 2 }, a: 1 })).toBe(false);
  });

  test('a changed nested field is different', () => {
    expect(draftsDiffer({ steps: [{ type: 'show_text', text: 'hi' }] }, { steps: [{ type: 'show_text', text: 'hi!' }] })).toBe(true);
  });

  test('array order matters (steps run in order)', () => {
    expect(draftsDiffer([1, 2], [2, 1])).toBe(true);
  });

  test('an undefined property is the same as a missing one', () => {
    expect(draftsDiffer({ a: 1, b: undefined }, { a: 1 })).toBe(false);
  });

  test('a fresh copy of the same value is not different', () => {
    const saved = { name: 'Raid hype', enabled: true };
    expect(draftsDiffer({ ...saved }, saved)).toBe(false);
  });
});

describe('stableStringify', () => {
  test('sorts keys at every depth', () => {
    expect(stableStringify({ b: 1, a: { d: 1, c: 2 } })).toBe('{"a":{"c":2,"d":1},"b":1}');
  });
});

describe('draftIsDirty', () => {
  test('no open draft is never dirty', () => {
    expect(draftIsDirty(null, { a: 1 })).toBe(false);
    expect(draftIsDirty(undefined, null)).toBe(false);
  });

  test('a draft equal to what it was opened from is clean', () => {
    expect(draftIsDirty({ name: '' }, { name: '' })).toBe(false);
  });

  test('typing into a new item makes it dirty', () => {
    expect(draftIsDirty({ name: 'R' }, { name: '' })).toBe(true);
  });

  test('typing and then deleting back to the saved value is clean again', () => {
    expect(draftIsDirty({ name: 'Raid' }, { name: 'Raid' })).toBe(false);
  });

  test('a draft without a baseline is treated as dirty', () => {
    expect(draftIsDirty({ name: '' }, null)).toBe(true);
  });
});

describe('describeUnsaved', () => {
  test('one label is used as-is', () => {
    expect(describeUnsaved(['the AI settings'])).toBe('the AI settings');
  });

  test('two labels are joined with "and"', () => {
    expect(describeUnsaved(['the speech settings', 'the Tengwar service'])).toBe('the speech settings and the Tengwar service');
  });

  test('duplicates collapse and long lists are capped', () => {
    expect(describeUnsaved(['a', 'a', 'b'])).toBe('a and b');
    expect(describeUnsaved(['a', 'b', 'c', 'd', 'e'])).toBe('a, b, c and 2 more');
  });

  test('no labels still reads as a sentence', () => {
    expect(describeUnsaved([])).toBe('this page');
  });
});

describe('discardPrompt', () => {
  test('names what would be lost and defaults focus away from discarding', () => {
    const prompt = discardPrompt(['the trigger "Raid"']);
    expect(prompt.title).toBe('Discard unsaved changes?');
    expect(String(prompt.body)).toContain('the trigger "Raid"');
    expect(prompt.tone).toBe('danger');
    expect(prompt.cancelLabel).toBe('Keep editing');
  });
});

describe('createDirtyRegistry', () => {
  test('reports a flip only when the first editor turns dirty and the last turns clean', () => {
    const registry = createDirtyRegistry();
    expect(registry.set('a', 'the action')).toBe(true);
    expect(registry.set('b', 'the trigger')).toBe(false);
    expect(registry.any()).toBe(true);
    expect(registry.labels()).toEqual(['the action', 'the trigger']);
    expect(registry.set('a', null)).toBe(false);
    expect(registry.set('b', null)).toBe(true);
    expect(registry.any()).toBe(false);
  });

  test('re-marking a dirty editor updates its label without a flip', () => {
    const registry = createDirtyRegistry();
    registry.set('a', 'the action "R"');
    expect(registry.set('a', 'the action "Ra"')).toBe(false);
    expect(registry.labels()).toEqual(['the action "Ra"']);
  });

  test('clearing an editor that was never dirty is a no-op', () => {
    const registry = createDirtyRegistry();
    expect(registry.set('ghost', null)).toBe(false);
    expect(registry.any()).toBe(false);
  });
});
