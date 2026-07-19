import { describe, expect, test } from 'bun:test';
import { isMentionOf, parseLinkToken } from './chatText';

describe('isMentionOf', () => {
  test('matches the bare login and the @-prefixed form', () => {
    expect(isMentionOf('codeacula how do i do this', 'codeacula')).toBe(true);
    expect(isMentionOf('hey @codeacula!', 'codeacula')).toBe(true);
    expect(isMentionOf('HEY @CodeAcula', 'codeacula')).toBe(true);
  });

  test('does not match the login inside a longer word', () => {
    expect(isMentionOf('codeaculabot said hi', 'codeacula')).toBe(false);
    expect(isMentionOf('thanks not_codeacula', 'codeacula')).toBe(false);
  });

  // The regression this replaced: the old substring test pinged on every clip link.
  test('does not match the login inside a URL path', () => {
    expect(isMentionOf('https://twitch.tv/codeacula', 'codeacula')).toBe(false);
    // Chat posts this form far more often than the scheme'd one, and it has no
    // scheme to recognise — caught in the browser after the tests above passed.
    expect(isMentionOf('i watch twitch.tv/codeacula every week', 'codeacula')).toBe(false);
    expect(isMentionOf('see youtube.com/@codeacula', 'codeacula')).toBe(false);
  });

  test('does not match a hostname built from the login', () => {
    expect(isMentionOf('codeacula.com is up', 'codeacula')).toBe(false);
    expect(isMentionOf('mail.codeacula is not you', 'codeacula')).toBe(false);
  });

  test('still matches a mention that simply ends a sentence', () => {
    expect(isMentionOf('thanks codeacula.', 'codeacula')).toBe(true);
    expect(isMentionOf('thanks @codeacula!', 'codeacula')).toBe(true);
  });

  test('an unset channel never mentions', () => {
    expect(isMentionOf('codeacula', '')).toBe(false);
    expect(isMentionOf('codeacula', '   ')).toBe(false);
  });

  test('surrounding punctuation still counts', () => {
    expect(isMentionOf('(codeacula)', 'codeacula')).toBe(true);
    expect(isMentionOf('codeacula, hi', 'codeacula')).toBe(true);
  });
});

describe('parseLinkToken', () => {
  test('recognises http, https, and www tokens', () => {
    expect(parseLinkToken('https://example.com/a')?.href).toBe('https://example.com/a');
    expect(parseLinkToken('http://example.com')?.href).toBe('http://example.com');
    expect(parseLinkToken('www.example.com')?.href).toBe('https://www.example.com');
  });

  test('leaves non-URL tokens alone', () => {
    expect(parseLinkToken('hello')).toBeNull();
    expect(parseLinkToken('example.com')).toBeNull();
    // No scheme we allow means no anchor — a chat message can't emit javascript:.
    expect(parseLinkToken('javascript:alert(1)')).toBeNull();
    expect(parseLinkToken('https://')).toBeNull();
    expect(parseLinkToken('www.')).toBeNull();
  });

  test('peels trailing sentence punctuation off the anchor', () => {
    expect(parseLinkToken('https://example.com/a.')).toEqual({
      href: 'https://example.com/a',
      label: 'https://example.com/a',
      trailing: '.',
    });
    expect(parseLinkToken('https://example.com/a?!')?.trailing).toBe('?!');
  });

  test('peels an unbalanced closing bracket but keeps a balanced one', () => {
    expect(parseLinkToken('https://example.com/a)')?.label).toBe('https://example.com/a');
    expect(parseLinkToken('https://en.wikipedia.org/wiki/Foo_(bar)')?.label)
      .toBe('https://en.wikipedia.org/wiki/Foo_(bar)');
  });
});
