import { getAppConfigInternal } from './appConfig';
import { db } from './db';

/**
 * Who the stored Twitch OAuth tokens belong to, and the channel derived from them.
 *
 * Deliberately its own module rather than part of twitch/auth.ts: auth.ts both
 * writes the identity and reads appConfig, so folding this in would make every
 * appConfig consumer drag the OAuth flow along with it.
 */

export type TwitchAccount = 'user' | 'bot';

const PROVIDERS: Record<TwitchAccount, string> = { user: 'twitch', bot: 'twitch_bot' };

const selectIdentity = db.prepare(`
  select account_user_id as userId, account_login as login
  from twitch_oauth
  where provider = ?
`);

const updateIdentity = db.prepare(`
  update twitch_oauth set account_user_id = ?, account_login = ? where provider = ?
`);

export type TwitchIdentity = { userId: string; login: string };

// The user login is read on every getTwitchChannel() call, which is per chat
// message — cache it rather than hitting SQLite each time. `undefined` means "not
// loaded yet"; `null` means "loaded, nobody is signed in".
const cache = new Map<TwitchAccount, TwitchIdentity | null>();

export function getTwitchIdentity(account: TwitchAccount): TwitchIdentity | null {
  const cached = cache.get(account);
  if (cached !== undefined) return cached;

  const row = selectIdentity.get(PROVIDERS[account]) as { userId: string | null; login: string | null } | null;
  const identity = row?.login ? { userId: row.userId ?? '', login: row.login.toLowerCase() } : null;
  cache.set(account, identity);
  return identity;
}

/** The signed-in broadcaster's login, or '' when nobody is signed in. */
export function getAuthenticatedTwitchLogin(): string {
  return getTwitchIdentity('user')?.login ?? '';
}

/**
 * The channel every service actually operates on: the stored override if the
 * operator typed one, otherwise the login they signed in with. Nobody runs a
 * dashboard for a channel they aren't logged into, so making them type their own
 * name was a required field that could only ever be wrong.
 *
 * `AppConfigInternal.twitchChannel` stays the *stored* value — Settings has to
 * render an empty field as empty, or saving the form would silently freeze the
 * derived login into an override.
 */
export function getTwitchChannel(): string {
  return getAppConfigInternal().twitchChannel || getAuthenticatedTwitchLogin();
}

/**
 * Record who a freshly stored token belongs to. Returns true when the user login
 * actually changed, so the caller can reconnect the services keyed to the channel
 * instead of doing it on every token refresh.
 */
export function setTwitchIdentity(account: TwitchAccount, identity: TwitchIdentity): boolean {
  const login = identity.login.trim().toLowerCase();
  if (!login) return false;
  const previous = getTwitchIdentity(account);
  updateIdentity.run(identity.userId || null, login, PROVIDERS[account]);
  cache.set(account, { userId: identity.userId, login });
  return previous?.login !== login;
}

/** Called when a token is revoked; the row is already gone, so just drop the cache. */
export function clearTwitchIdentity(account: TwitchAccount) {
  cache.set(account, null);
}

/** Test seam — the cache outlives a single test's database otherwise. */
export function resetTwitchIdentityCache() {
  cache.clear();
}
