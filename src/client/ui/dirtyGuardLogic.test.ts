import { describe, expect, test } from 'bun:test';
import {
  createDirtyRegistry,
  describeUnsaved,
  discardPrompt,
  draftIsDirty,
  draftsDiffer,
  keepOpenInView,
  leavePrompt,
  runUnlessRefused,
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

describe('runUnlessRefused', () => {
  test('nothing dirty runs at once, without asking', () => {
    const asked: string[][] = [];
    let ran = false;
    runUnlessRefused([], async labels => { asked.push(labels); return true; }, () => { ran = true; });
    expect(ran).toBe(true);
    expect(asked).toEqual([]);
  });

  test('asks about every dirty editor, not only the caller\'s', async () => {
    // The trigger editor is clean but its viewer-override row holds a typed login.
    const registry = createDirtyRegistry();
    registry.set('trigger-editor', null);
    registry.set('override-row', 'the new viewer override');
    const asked: string[][] = [];
    let ran = false;
    runUnlessRefused(registry.labels(), async labels => { asked.push(labels); return false; }, () => { ran = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(asked).toEqual([['the new viewer override']]);
    expect(ran).toBe(false);
  });

  test('a yes runs the switch', async () => {
    let ran = false;
    runUnlessRefused(['the trigger "Raid"'], async () => true, () => { ran = true; });
    expect(ran).toBe(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(ran).toBe(true);
  });
});

describe('keepOpenInView', () => {
  type Card = { id: string; text: string; hidden: boolean };
  const cards: Card[] = [
    { id: 'a', text: 'pizza', hidden: false },
    { id: 'b', text: 'tacos', hidden: true },
    { id: 'c', text: 'pizza again', hidden: false },
  ];
  const idOf = (card: Card) => card.id;

  test('with nothing open it is a plain filter', () => {
    expect(keepOpenInView(cards, card => card.text.includes('pizza'), new Set<string>(), idOf).map(idOf)).toEqual(['a', 'c']);
  });

  test('a card with an open editor survives a filter that excludes it', () => {
    // Editing "tacos", then typing "pizza" into Find.
    expect(keepOpenInView(cards, card => card.text.includes('pizza'), new Set(['b']), idOf).map(idOf)).toEqual(['a', 'b', 'c']);
  });

  test('a hidden card with unsaved tags survives "Show hidden" switching off', () => {
    expect(keepOpenInView(cards, card => !card.hidden, new Set(['b']), idOf).map(idOf)).toEqual(['a', 'b', 'c']);
    expect(keepOpenInView(cards, card => !card.hidden, new Set<string>(), idOf).map(idOf)).toEqual(['a', 'c']);
  });

  test('an open id with no item (a removed card) adds nothing', () => {
    expect(keepOpenInView(cards, () => false, new Set(['gone']), idOf)).toEqual([]);
  });
});

describe('leavePrompt', () => {
  const tokenPrompt = {
    title: 'Leave without copying the token?',
    body: 'It is shown only once. Without a copy, "pztmi" needs another new token.',
    confirmLabel: 'Leave without it',
    cancelLabel: 'Stay and copy it',
  };

  test('plain edits get the generic discard prompt', () => {
    const prompt = leavePrompt([{ label: 'the trigger "Raid"' }]);
    expect(prompt.title).toBe('Discard unsaved changes?');
    expect(String(prompt.body)).toContain('the trigger "Raid"');
  });

  test('work with its own question is asked in its own words', () => {
    const prompt = leavePrompt([{ label: 'the new token for "pztmi"', prompt: tokenPrompt }]);
    expect(prompt.title).toBe('Leave without copying the token?');
    expect(prompt.body).toBe(tokenPrompt.body);
    expect(prompt.confirmLabel).toBe('Leave without it');
    expect(prompt.cancelLabel).toBe('Stay and copy it');
    // Still a danger confirm, so a stray Enter lands on "Stay".
    expect(prompt.tone).toBe('danger');
  });

  test('a custom question without labels falls back to Leave anyway / Stay', () => {
    const prompt = leavePrompt([{ label: 'x', prompt: { title: 'T?', body: 'B.' } }]);
    expect(prompt.confirmLabel).toBe('Leave anyway');
    expect(prompt.cancelLabel).toBe('Stay');
  });

  test('mixed with a plain edit, the generic prompt names everything at stake', () => {
    const prompt = leavePrompt([
      { label: 'the new token for "pztmi"', prompt: tokenPrompt },
      { label: 'the new app' },
    ]);
    expect(prompt.title).toBe('Discard unsaved changes?');
    expect(String(prompt.body)).toContain('the new token for "pztmi"');
    expect(String(prompt.body)).toContain('the new app');
  });
});

describe('createDirtyRegistry with a custom prompt', () => {
  test('keeps the prompt beside the label, and labels() stays a plain list', () => {
    const registry = createDirtyRegistry();
    registry.set('token', 'the new token', { title: 'T?', body: 'B.' });
    registry.set('app', 'the new app');
    expect(registry.labels()).toEqual(['the new token', 'the new app']);
    expect(registry.entries()).toEqual([
      { label: 'the new token', prompt: { title: 'T?', body: 'B.' } },
      { label: 'the new app' },
    ]);
  });
});
