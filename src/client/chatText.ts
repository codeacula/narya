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

function count(text: string, char: string): number {
  let total = 0;
  for (const c of text) if (c === char) total += 1;
  return total;
}

export type LinkToken = {
  /** Where the anchor points. `www.` tokens get an https:// scheme. */
  href: string;
  /** What the anchor renders — the URL exactly as typed, minus trailing punctuation. */
  label: string;
  /** Punctuation peeled off the end, re-emitted as plain text after the anchor. */
  trailing: string;
};

/**
 * Parse one whitespace-free chat token as a URL, or null if it isn't one.
 *
 * Only `http://`, `https://`, and `www.` are recognised, so a chat message can
 * never produce a `javascript:` href. Trailing sentence punctuation and unbalanced
 * closing brackets are peeled off: "see https://x.com/a." should link the URL, not
 * the full stop, and "(https://x.com/a)" should not swallow the paren.
 */
export function parseLinkToken(token: string): LinkToken | null {
  if (!LINK_PREFIX.test(token)) return null;

  let label = token;
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

  // Re-check after peeling: "www." is a prefix and a full stop, not a link, and
  // "https://" on its own carries no host.
  if (!LINK_PREFIX.test(label)) return null;
  if (!label.replace(LINK_PREFIX, '')) return null;

  const href = /^www\./i.test(label) ? `https://${label}` : label;
  return { href, label, trailing };
}
