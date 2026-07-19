/**
 * Pure text helpers shared by every chat surface (overlay, dashboard, tablet,
 * spotlight). Kept out of chat.tsx so they can be tested without a renderer.
 */

// Twitch logins are [a-z0-9_], so escaping is belt-and-braces — but the channel
// can be an arbitrary operator-typed string before validation lands, and a stray
// `(` would otherwise throw while building the mention pattern.
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * True when `text` names `channel` as a whole word, with or without a leading `@`.
 *
 * Deliberately not a substring test. The dashboard used `text.includes(channel)`,
 * which pinged on every message that merely contained the login — a clip URL
 * (`twitch.tv/codeacula`), a longer name (`codeaculabot`), an emote code. A ping
 * that fires on non-pings stops being a signal.
 */
export function isMentionOf(text: string, channel: string): boolean {
  const login = channel.trim().toLowerCase();
  if (!login) return false;

  const pattern = new RegExp(
    // `@` and `.` in the lookbehind rule out `foo@login` and `sub.login`; the `@?`
    // alternative is what still allows a genuine `@login`.
    `(?<![\\w@.])@?${escapeRegExp(login)}` +
    // Not part of a longer word (`loginbot`)…
    `(?![\\w])` +
    // …and not the start of a hostname (`login.com`). A bare trailing dot is fine,
    // because "thanks login." is the most ordinary mention there is.
    `(?!\\.[a-z0-9])`,
    'i',
  );

  return text.split(/\s+/).some(token => {
    // A URL that merely contains the login is not someone talking to you. Both
    // checks are needed: parseLinkToken catches the scheme'd forms, and the `/`
    // test catches the schemeless `twitch.tv/login` that chat actually posts.
    if (parseLinkToken(token) || token.includes('/')) return false;
    return pattern.test(token);
  });
}

const LINK_PREFIX = /^(?:https?:\/\/|www\.)/i;
const SENTENCE_PUNCTUATION = new Set(['.', ',', '!', '?', ';', ':', "'", '"', '…']);
const CLOSERS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
const OPENERS = new Set(['(', '[', '{', '"', "'", '«', '‘', '“']);

/**
 * A schemeless token that *looks* like a host: labels joined by dots, with an optional
 * port and an optional path/query/fragment. Deliberately excludes `@`, so an email
 * address never reaches the TLD check and never becomes a mailto-ish anchor.
 */
const SCHEMELESS_HOST =
  /^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)(?::\d{1,5})?(?:[/?#]\S*)?$/i;

/**
 * The TLDs a schemeless token is allowed to link on.
 *
 * An allowlist rather than a `word.word` pattern, because the pattern linkifies far
 * more than it catches: `Node.js`, `config.json`, `script.py`, `README.md`, `v1.2.3`
 * and `U.S.` are all `word.word`. Restricting to TLDs people actually post in chat
 * keeps `twitch.tv/foo` working without turning every filename into an anchor.
 *
 * Two-letter ccTLDs that are also ordinary English words (`to`, `so`, `no`, `it`,
 * `in`, `at`, `is`, `us`, `my`) are deliberately left out: a missing space after a
 * full stop is common in chat and would otherwise link half the sentence. `be` and
 * `me` are the exceptions, kept because `youtu.be` and `t.me` are posted constantly.
 */
const LINKABLE_TLDS = new Set([
  // generic
  'com', 'net', 'org', 'edu', 'gov', 'int', 'mil',
  'io', 'ai', 'dev', 'app', 'xyz', 'info', 'biz', 'tech', 'live', 'art', 'blog',
  'shop', 'store', 'news', 'wiki', 'online', 'site', 'space', 'club', 'games', 'gay',
  // link shorteners and platform hosts chat actually posts
  'tv', 'gg', 'be', 'ly', 'gl', 'co', 'me', 'fm', 'cc', 'sh', 'gd',
  // country codes that are not also English words
  'uk', 'ca', 'de', 'fr', 'jp', 'au', 'nz', 'nl', 'se', 'es', 'br', 'mx', 'pl',
  'ru', 'kr', 'tw', 'cn', 'ch', 'dk', 'fi', 'ie', 'pt', 'ro', 'cz', 'gr', 'hu',
  'il', 'tr', 'za', 'ua',
]);

function count(text: string, char: string): number {
  let total = 0;
  for (const c of text) if (c === char) total += 1;
  return total;
}

export type LinkToken = {
  /** Where the anchor points. `www.` and schemeless tokens get an https:// scheme. */
  href: string;
  /** What the anchor renders — the URL exactly as typed, minus peeled punctuation. */
  label: string;
  /** Punctuation peeled off the front, re-emitted as plain text before the anchor. */
  leading: string;
  /** Punctuation peeled off the end, re-emitted as plain text after the anchor. */
  trailing: string;
};

/**
 * True when a schemeless token is a host we are willing to link — see LINKABLE_TLDS
 * for why this is an allowlist and not a pattern.
 */
function isLinkableHost(label: string): boolean {
  const match = SCHEMELESS_HOST.exec(label);
  if (!match) return false;
  const labels = match[1].split('.');
  return LINKABLE_TLDS.has(labels[labels.length - 1].toLowerCase());
}

/**
 * Parse one whitespace-free chat token as a URL, or null if it isn't one.
 *
 * Three forms are recognised: `http://`, `https://`, and `www.` as before, plus a
 * schemeless host whose TLD is on LINKABLE_TLDS — `twitch.tv/foo` is the form chat
 * actually posts, and rejecting it was why typing a link in the dashboard produced
 * plain text. Any other scheme still fails the check, so a chat message can never
 * produce a `javascript:` or `data:` href.
 *
 * Punctuation is peeled off both ends and re-emitted around the anchor: "see
 * https://x.com/a." links the URL and not the full stop, "(https://x.com/a)" keeps
 * both parens outside the link, and a balanced bracket inside the URL is preserved
 * (`/wiki/Foo_(bar)`).
 */
export function parseLinkToken(token: string): LinkToken | null {
  let label = token;

  // Front first: LINK_PREFIX and SCHEMELESS_HOST are both `^`-anchored, so a leading
  // quote or paren made the token fail to match at all — `(https://x.com` was not a
  // link, even though the trailing `)` had always been handled.
  let leading = '';
  while (label && OPENERS.has(label[0])) {
    leading += label[0];
    label = label.slice(1);
  }

  let trailing = '';
  for (;;) {
    const last = label[label.length - 1];
    if (!last) break;
    const opener = CLOSERS[last];
    const unbalanced = opener !== undefined && count(label, last) > count(label, opener);
    if (!SENTENCE_PUNCTUATION.has(last) && !unbalanced) break;
    label = label.slice(0, -1);
    trailing = last + trailing;
  }

  if (LINK_PREFIX.test(label)) {
    // "www." is a prefix and a full stop, not a link, and "https://" carries no host.
    if (!label.replace(LINK_PREFIX, '')) return null;
    const href = /^www\./i.test(label) ? `https://${label}` : label;
    return { href, label, leading, trailing };
  }

  // The label keeps the schemeless form the viewer typed; only the href gains a
  // scheme, so chat still reads `twitch.tv/foo` rather than a URL nobody wrote.
  if (isLinkableHost(label)) return { href: `https://${label}`, label, leading, trailing };

  return null;
}
