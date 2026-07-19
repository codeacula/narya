import { beforeEach, describe, expect, test } from 'bun:test';
import { db } from './db';
import {
  addQuote,
  countQuotes,
  deleteQuote,
  getQuote,
  listQuotes,
  normalizeQuoteSlug,
  anonymizeQuotesByLogin,
  recordQuoteShown,
  resolveQuote,
  updateQuote,
} from './quotes';

function reset() {
  db.exec('delete from quotes');
  db.exec('update quote_sequence set next_number = 1 where id = 1');
}

beforeEach(reset);

/** Always picks the first candidate, so "random among matches" is assertable. */
const first = () => 0;

describe('addQuote', () => {
  test('stores the text, submitter, and a zeroed counter', () => {
    const quote = addQuote({ text: "I'm hungry for pizza!", submittedBy: 'Sorlus', submittedByLogin: 'Sorlus' });

    expect(quote.number).toBe(1);
    expect(quote.text).toBe("I'm hungry for pizza!");
    expect(quote.submittedBy).toBe('Sorlus');
    expect(quote.submittedByLogin).toBe('sorlus');
    expect(quote.shownCount).toBe(0);
    expect(quote.lastShownAt).toBeNull();
    expect(quote.createdAt).toBeTruthy();
  });

  test('numbers quotes in submission order', () => {
    expect(addQuote({ text: 'one' }).number).toBe(1);
    expect(addQuote({ text: 'two' }).number).toBe(2);
    expect(addQuote({ text: 'three' }).number).toBe(3);
  });

  test('never reuses the number of a deleted quote', () => {
    addQuote({ text: 'one' });
    const second = addQuote({ text: 'two' });

    expect(deleteQuote(second.id)).toBe(true);
    // max(number) + 1 would hand out 2 again and quietly repoint "quote 2" at a
    // different quote. The sequence must move forward instead.
    expect(addQuote({ text: 'three' }).number).toBe(3);
  });

  test('rejects an empty quote', () => {
    expect(() => addQuote({ text: '   ' })).toThrow();
    expect(countQuotes()).toBe(0);
  });

  test('rejects a quote over the length cap', () => {
    expect(() => addQuote({ text: 'x'.repeat(501) })).toThrow();
    expect(countQuotes()).toBe(0);
  });

  test('rejects a duplicate slug', () => {
    addQuote({ text: 'one', slug: 'farts' });
    expect(() => addQuote({ text: 'two', slug: 'farts' })).toThrow();
    expect(countQuotes()).toBe(1);
  });

  test('allows many quotes with no slug', () => {
    addQuote({ text: 'one' });
    addQuote({ text: 'two' });
    expect(listQuotes().every(quote => quote.slug === null)).toBe(true);
  });

  test('falls back to a placeholder submitter rather than an empty one', () => {
    expect(addQuote({ text: 'one', submittedBy: '  ' }).submittedBy).toBe('unknown');
  });
});

describe('normalizeQuoteSlug', () => {
  test('lowercases and strips a leading sigil', () => {
    expect(normalizeQuoteSlug('!Farts')).toBe('farts');
  });

  test('treats blank as absent', () => {
    expect(normalizeQuoteSlug('   ')).toBeNull();
    expect(normalizeQuoteSlug(undefined)).toBeNull();
  });

  test('rejects a digits-only slug that a quote number would shadow', () => {
    // resolveQuote tries the number tier first, so slug "12" could never be reached.
    expect(() => normalizeQuoteSlug('12')).toThrow();
  });

  test('rejects a slug with spaces', () => {
    expect(() => normalizeQuoteSlug('two words')).toThrow();
  });

  test('rejects a slug over the length cap', () => {
    expect(() => normalizeQuoteSlug('a'.repeat(61))).toThrow();
  });
});

describe('resolveQuote', () => {
  beforeEach(() => {
    addQuote({ text: "I'm hungry for pizza!", slug: 'pizza', submittedBy: 'Sorlus' });
    addQuote({ text: 'That was a loud one', slug: 'farts', submittedBy: 'Bob' });
    addQuote({ text: 'Pizza is a vegetable', submittedBy: 'Ann' });
  });

  test('finds by number', () => {
    expect(resolveQuote('2', first)!.text).toBe('That was a loud one');
  });

  test('finds by slug, case-insensitively', () => {
    expect(resolveQuote('FARTS', first)!.number).toBe(2);
  });

  test('tolerates a slug typed with a sigil', () => {
    expect(resolveQuote('!farts', first)!.number).toBe(2);
  });

  test('a number never falls through to a keyword search', () => {
    // "3" matches nothing by number once quote 3 is gone; it must not then match
    // a quote whose text happens to contain "3".
    addQuote({ text: 'you owe me 3 dollars' });
    const three = resolveQuote('3', first)!;
    expect(three.text).toBe('Pizza is a vegetable');

    deleteQuote(three.id);
    expect(resolveQuote('3', first)).toBeNull();
  });

  test('an exact slug beats a keyword match in another quote', () => {
    // "pizza" is quote 1's slug and also appears in quote 3's text.
    expect(resolveQuote('pizza', first)!.number).toBe(1);
  });

  test('falls back to a keyword search of the text', () => {
    expect(resolveQuote('vegetable', first)!.number).toBe(3);
  });

  test('picks among multiple keyword matches', () => {
    addQuote({ text: 'loud noises everywhere' });
    const matches = [0, 1].map(index => resolveQuote('loud', () => index)!.number);
    expect(new Set(matches).size).toBe(2);
  });

  test('an empty query means any quote, not no quote', () => {
    expect(resolveQuote('', first)).not.toBeNull();
    expect(resolveQuote('   ', first)).not.toBeNull();
  });

  test('returns null when nothing matches', () => {
    expect(resolveQuote('nonexistent', first)).toBeNull();
  });

  test('returns null on an empty query with no quotes at all', () => {
    reset();
    expect(resolveQuote('', first)).toBeNull();
  });

  test('treats LIKE wildcards in a keyword as literal text', () => {
    // Without escaping, "%" matches every quote and `!quote %` returns a random one
    // instead of nothing.
    expect(resolveQuote('%', first)).toBeNull();
    expect(resolveQuote('_', first)).toBeNull();
  });
});

describe('recordQuoteShown', () => {
  test('increments the counter and stamps the time', () => {
    const quote = addQuote({ text: 'one' });
    recordQuoteShown(quote.id, new Date('2026-07-19T12:00:00.000Z'));

    const after = getQuote(quote.id)!;
    expect(after.shownCount).toBe(1);
    expect(after.lastShownAt).toBe('2026-07-19T12:00:00.000Z');
  });

  test('accumulates across shows', () => {
    const quote = addQuote({ text: 'one' });
    recordQuoteShown(quote.id);
    recordQuoteShown(quote.id);
    recordQuoteShown(quote.id);
    expect(getQuote(quote.id)!.shownCount).toBe(3);
  });
});

describe('updateQuote', () => {
  test('changes only the fields supplied', () => {
    const quote = addQuote({ text: 'one', slug: 'first', submittedBy: 'Sorlus' });
    const updated = updateQuote(quote.id, { text: 'one, revised' });

    expect(updated.text).toBe('one, revised');
    expect(updated.slug).toBe('first');
    expect(updated.submittedBy).toBe('Sorlus');
    expect(updated.number).toBe(quote.number);
  });

  test('an explicit null clears the slug', () => {
    const quote = addQuote({ text: 'one', slug: 'first' });
    expect(updateQuote(quote.id, { slug: null }).slug).toBeNull();
  });

  test('preserves the shown counter', () => {
    const quote = addQuote({ text: 'one' });
    recordQuoteShown(quote.id);
    expect(updateQuote(quote.id, { text: 'two' }).shownCount).toBe(1);
  });

  test('rejects a slug already held by another quote', () => {
    addQuote({ text: 'one', slug: 'taken' });
    const second = addQuote({ text: 'two', slug: 'free' });
    expect(() => updateQuote(second.id, { slug: 'taken' })).toThrow();
    expect(getQuote(second.id)!.slug).toBe('free');
  });

  test('lets a quote keep its own slug', () => {
    const quote = addQuote({ text: 'one', slug: 'mine' });
    expect(updateQuote(quote.id, { slug: 'mine', text: 'edited' }).text).toBe('edited');
  });

  test('rejects an unknown id', () => {
    expect(() => updateQuote('nope', { text: 'x' })).toThrow();
  });
});

describe('deleteQuote', () => {
  test('reports whether anything was removed', () => {
    const quote = addQuote({ text: 'one' });
    expect(deleteQuote(quote.id)).toBe(true);
    expect(deleteQuote(quote.id)).toBe(false);
    expect(countQuotes()).toBe(0);
  });
});

describe('anonymizeQuotesByLogin', () => {
  test('clears attribution but keeps the quote, its number, and its counter', () => {
    const quote = addQuote({ text: 'keep me', submittedBy: 'SpamBob', submittedByLogin: 'spambob' });
    recordQuoteShown(quote.id);

    expect(anonymizeQuotesByLogin('spambob')).toBe(1);

    const after = getQuote(quote.id)!;
    expect(after.number).toBe(quote.number);
    expect(after.text).toBe('keep me');
    expect(after.shownCount).toBe(1);
    expect(after.submittedBy).toBe('unknown');
    expect(after.submittedByLogin).toBe('');
  });

  test('normalizes the login it is given', () => {
    // Called directly (not via flushViewer, which pre-lowercases), so this is the only
    // place the function's own trim/lowercase is actually under test.
    addQuote({ text: 'one', submittedBy: 'Bob', submittedByLogin: 'bob' });
    expect(anonymizeQuotesByLogin('  BOB  ')).toBe(1);
  });

  test('anonymizes every quote that login submitted', () => {
    addQuote({ text: 'one', submittedBy: 'Bob', submittedByLogin: 'bob' });
    addQuote({ text: 'two', submittedBy: 'Bob', submittedByLogin: 'bob' });
    addQuote({ text: 'three', submittedBy: 'Ann', submittedByLogin: 'ann' });
    expect(anonymizeQuotesByLogin('bob')).toBe(2);
    expect(listQuotes().filter(q => q.submittedBy === 'unknown')).toHaveLength(2);
  });

  test('a blank login is a no-op, not a mass anonymize', () => {
    // Slug-less quotes store '' for submittedByLogin, so a blank key that reached the
    // WHERE clause would wipe attribution across the whole book.
    addQuote({ text: 'no login recorded', submittedBy: 'Ann' });
    expect(anonymizeQuotesByLogin('   ')).toBe(0);
    expect(listQuotes()[0]!.submittedBy).toBe('Ann');
  });

  test('reports zero when that login submitted nothing', () => {
    addQuote({ text: 'one', submittedBy: 'Ann', submittedByLogin: 'ann' });
    expect(anonymizeQuotesByLogin('nobody')).toBe(0);
  });
});
