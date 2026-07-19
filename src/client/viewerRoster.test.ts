import { describe, expect, test } from 'bun:test';
import type { Chatter, ViewerRosterEntry } from '../shared/api';
import { mergeRoster } from './viewerRoster';

function rosterEntry(overrides: Partial<ViewerRosterEntry> = {}): ViewerRosterEntry {
  return {
    login: 'sorlus',
    display: 'Sorlus',
    color: '#fff',
    roles: [],
    messageCount: 12,
    firstSeenAt: '2026-07-01T00:00:00.000Z',
    lastSeenAt: '2026-07-19T00:00:00.000Z',
    note: '',
    isLurker: false,
    missing: false,
    ...overrides,
  } as ViewerRosterEntry;
}

function chatter(login: string, name?: string): Chatter {
  return { userId: login, userLogin: login, userName: name ?? login } as Chatter;
}

const NONE = new Set<string>();

function merge(over: Partial<Parameters<typeof mergeRoster>[0]> = {}) {
  return mergeRoster({
    roster: [], vips: [], mods: [], liveLogins: NONE, ignoredLogins: NONE, ...over,
  });
}

describe('mergeRoster', () => {
  test('includes stored roster entries', () => {
    expect(merge({ roster: [rosterEntry()] }).map(p => p.login)).toEqual(['sorlus']);
  });

  test('synthesizes VIPs and mods who have never chatted', () => {
    const people = merge({ vips: [chatter('vippy')], mods: [chatter('moddy')] });
    expect(people.map(p => p.login).sort()).toEqual(['moddy', 'vippy']);
    expect(people.find(p => p.login === 'vippy')!.roles.has('vip')).toBe(true);
    expect(people.find(p => p.login === 'moddy')!.roles.has('mod')).toBe(true);
  });

  test('takes VIP and mod roles from the live lists, not stale badges', () => {
    const people = merge({ roster: [rosterEntry({ login: 'sorlus' })], vips: [chatter('sorlus')] });
    expect(people[0]!.roles.has('vip')).toBe(true);
  });

  test('sorts alphabetically by login', () => {
    const people = merge({ roster: [rosterEntry({ login: 'zed' }), rosterEntry({ login: 'abe' })] });
    expect(people.map(p => p.login)).toEqual(['abe', 'zed']);
  });
});

/**
 * The defect these cover: a flush deletes the chatters row and records the login in
 * ignored_logins, and the server honours that on chat and presence. But the roster
 * synthesizes an entry for every VIP/mod missing from the roster — reading the live
 * Twitch role lists, which know nothing about the ignore. So flushing a VIP or
 * moderator removed them for exactly as long as it took the next refresh to run,
 * which looked like Flush silently failing on the viewers most worth flushing.
 */
describe('mergeRoster and flushed viewers', () => {
  test('a flushed VIP is not synthesized back into the roster', () => {
    const people = merge({ vips: [chatter('vippy')], ignoredLogins: new Set(['vippy']) });
    expect(people).toHaveLength(0);
  });

  test('a flushed moderator is not synthesized back into the roster', () => {
    const people = merge({ mods: [chatter('moddy')], ignoredLogins: new Set(['moddy']) });
    expect(people).toHaveLength(0);
  });

  test('a viewer who is both VIP and moderator stays gone', () => {
    const people = merge({
      vips: [chatter('both')],
      mods: [chatter('both')],
      ignoredLogins: new Set(['both']),
    });
    expect(people).toHaveLength(0);
  });

  test('a flushed roster row is filtered too, if one somehow survives', () => {
    // The server deletes the row and blocks recreation, so this is belt and braces —
    // but the roster is what the operator sees, and it should agree with the flush.
    const people = merge({
      roster: [rosterEntry({ login: 'gone' })],
      ignoredLogins: new Set(['gone']),
    });
    expect(people).toHaveLength(0);
  });

  test('the ignore list is matched case-insensitively against the role lists', () => {
    const people = merge({ vips: [chatter('MixedCase')], ignoredLogins: new Set(['mixedcase']) });
    expect(people).toHaveLength(0);
  });

  test('flushing one viewer leaves everyone else alone', () => {
    const people = merge({
      roster: [rosterEntry({ login: 'keeper' })],
      vips: [chatter('vippy'), chatter('flushed')],
      ignoredLogins: new Set(['flushed']),
    });
    expect(people.map(p => p.login).sort()).toEqual(['keeper', 'vippy']);
  });

  test('an empty ignore set changes nothing', () => {
    const people = merge({ roster: [rosterEntry()], vips: [chatter('vippy')], ignoredLogins: NONE });
    expect(people).toHaveLength(2);
  });
});
