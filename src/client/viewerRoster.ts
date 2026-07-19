import type { Chatter, ViewerRosterEntry } from '../shared/api';

/**
 * One row of the viewer roster, merged from the stored roster and the live Twitch
 * VIP/moderator lists.
 */
export type Person = {
  login: string;
  display: string;
  color: string;
  roles: Set<string>;
  isLive: boolean;
  messageCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  note: string;
  /** Seen in the channel but has never typed — the reason they are in the roster at all. */
  isLurker: boolean;
  missing: boolean;
};

export type RosterSources = {
  roster: ViewerRosterEntry[];
  vips: Chatter[];
  mods: Chatter[];
  liveLogins: Set<string>;
  /**
   * Logins the operator flushed. Required, not optional: a caller that forgets it
   * would silently reintroduce the bug this parameter exists to prevent, and a
   * default of "none" is exactly the wrong failure direction.
   */
  ignoredLogins: Set<string>;
};

/**
 * Merge the stored roster with the live Twitch role lists.
 *
 * Extracted from the page and kept React-free so it can be tested directly. It was
 * a useMemo body when a flush bug lived in it undetected by a passing suite.
 */
export function mergeRoster({ roster, vips, mods, liveLogins, ignoredLogins }: RosterSources): Person[] {
  const vipSet = new Set(vips.map(v => v.userLogin.toLowerCase()));
  const modSet = new Set(mods.map(m => m.userLogin.toLowerCase()));
  const byLogin = new Map<string, Person>();

  const rolesFor = (login: string, badgeRoles: string[]): Set<string> => {
    const roles = new Set<string>();
    if (badgeRoles.includes('broadcaster')) roles.add('broadcaster');
    if (badgeRoles.includes('sub')) roles.add('sub');
    // VIP/mod come from the live Twitch lists, not stale message badges.
    if (vipSet.has(login)) roles.add('vip');
    if (modSet.has(login)) roles.add('mod');
    return roles;
  };

  for (const entry of roster) {
    const login = entry.login.toLowerCase();
    if (ignoredLogins.has(login)) continue;
    byLogin.set(login, {
      login,
      display: entry.display || login,
      color: entry.color || 'var(--silver-400)',
      roles: rolesFor(login, entry.roles),
      isLive: liveLogins.has(login),
      messageCount: entry.messageCount,
      firstSeenAt: entry.firstSeenAt,
      lastSeenAt: entry.lastSeenAt,
      note: entry.note,
      isLurker: entry.isLurker,
      missing: entry.missing,
    });
  }

  // VIPs/mods who have never chatted still belong in the roster so you can manage them.
  //
  // Except the flushed ones. A flush deletes the chatters row and records the login in
  // ignored_logins, and the server honours that on chat and presence — but this
  // synthesis reads the Twitch role lists, which know nothing about it. Without the
  // check a flushed VIP or moderator reappears on the very next refresh, so Flush
  // looked like it silently failed on exactly the viewers most worth flushing.
  for (const person of [...vips, ...mods]) {
    const login = person.userLogin.toLowerCase();
    if (byLogin.has(login) || ignoredLogins.has(login)) continue;
    byLogin.set(login, {
      login,
      display: person.userName || login,
      color: 'var(--silver-400)',
      roles: rolesFor(login, []),
      isLive: liveLogins.has(login),
      messageCount: 0,
      firstSeenAt: '',
      lastSeenAt: '',
      note: '',
      // Not "lurking": that means seen present via Helix, and these two came from the
      // VIP/mod lists with no chatters row behind them.
      isLurker: false,
      missing: false,
    });
  }

  // Alphabetical by username so the roster reads like a directory.
  return [...byLogin.values()].sort((a, b) => a.login.localeCompare(b.login));
}
