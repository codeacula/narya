import { db } from './db';

/**
 * Who the stored Twitch OAuth tokens belong to.
 *
 * Deliberately its own module rather than part of twitch/auth.ts: appConfig falls
 * back to the signed-in login when no channel has been typed, and auth.ts already
 * imports appConfig. This has no imports beyond db, so neither side gains a cycle.
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

// The user login is read on every appConfig.twitchChannel access, which is per chat
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
