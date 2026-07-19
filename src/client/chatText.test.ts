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
    // No scheme we allow means no anchor — a chat message can't emit javascript:.
    expect(parseLinkToken('javascript:alert(1)')).toBeNull();
    expect(parseLinkToken('https://')).toBeNull();
    expect(parseLinkToken('www.')).toBeNull();
  });

  test('peels trailing sentence punctuation off the anchor', () => {
    expect(parseLinkToken('https://example.com/a.')).toEqual({
      href: 'https://example.com/a',
      label: 'https://example.com/a',
      leading: '',
      trailing: '.',
    });
    expect(parseLinkToken('https://example.com/a?!')?.trailing).toBe('?!');
  });

  test('peels an unbalanced closing bracket but keeps a balanced one', () => {
    expect(parseLinkToken('https://example.com/a)')?.label).toBe('https://example.com/a');
    expect(parseLinkToken('https://en.wikipedia.org/wiki/Foo_(bar)')?.label)
      .toBe('https://en.wikipedia.org/wiki/Foo_(bar)');
  });

  // Leading punctuation used to defeat the match outright: LINK_PREFIX is `^`-anchored,
  // so `(https://x.com` was not a link at all, while the trailing `)` was handled fine.
  test('peels leading punctuation and re-emits it', () => {
    expect(parseLinkToken('(https://example.com/a)')).toEqual({
      href: 'https://example.com/a',
      label: 'https://example.com/a',
      leading: '(',
      trailing: ')',
    });
    expect(parseLinkToken('"www.example.com"')?.href).toBe('https://www.example.com');
  });
});

// The reported bug: typing a link in the dashboard did not linkify. The renderer was
// fine — the tokenizer only accepted http://, https://, and www., so the schemeless
// form chat actually posts was rejected.
describe('parseLinkToken — schemeless hosts', () => {
  test('links a schemeless host on the TLD allowlist', () => {
    expect(parseLinkToken('twitch.tv/codeacula')?.href).toBe('https://twitch.tv/codeacula');
    expect(parseLinkToken('youtu.be/dQw4w9WgXcQ')?.href).toBe('https://youtu.be/dQw4w9WgXcQ');
    expect(parseLinkToken('example.com')?.href).toBe('https://example.com');
    expect(parseLinkToken('discord.gg/abc')?.href).toBe('https://discord.gg/abc');
  });

  test('labels the host exactly as typed, without inventing a scheme in the text', () => {
    const link = parseLinkToken('twitch.tv/codeacula');
    expect(link?.label).toBe('twitch.tv/codeacula');
    expect(link?.href).toBe('https://twitch.tv/codeacula');
  });

  // The whole point of an allowlist. A bare `word.word` rule linkifies all of these.
  test('does not linkify filenames, versions, or prose that merely contains a dot', () => {
    expect(parseLinkToken('Node.js')).toBeNull();
    expect(parseLinkToken('config.json')).toBeNull();
    expect(parseLinkToken('script.py')).toBeNull();
    expect(parseLinkToken('README.md')).toBeNull();
    expect(parseLinkToken('3.5')).toBeNull();
    expect(parseLinkToken('v1.2.3')).toBeNull();
    expect(parseLinkToken('U.S.')).toBeNull();
    expect(parseLinkToken('etc.')).toBeNull();
    expect(parseLinkToken('...')).toBeNull();
  });

  test('an email address is not a link', () => {
    expect(parseLinkToken('someone@example.com')).toBeNull();
  });

  test('schemeless matching still peels punctuation', () => {
    expect(parseLinkToken('twitch.tv/codeacula.')).toEqual({
      href: 'https://twitch.tv/codeacula',
      label: 'twitch.tv/codeacula',
      leading: '',
      trailing: '.',
    });
    expect(parseLinkToken('(example.com)')?.label).toBe('example.com');
  });

  test('a schemeless host cannot smuggle in another scheme', () => {
    expect(parseLinkToken('data:text/html,x')).toBeNull();
    expect(parseLinkToken('file:///etc/passwd')).toBeNull();
    expect(parseLinkToken('javascript:void.com')).toBeNull();
  });
});
