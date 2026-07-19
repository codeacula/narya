import { beforeEach, describe, expect, test } from 'bun:test';
import { db } from './db';
import { hasSeenChatterBefore } from './streamSession';
import {
  flushViewer,
  ignoredLogins,
  isLoginIgnored,
  loginsMissingProfile,
  recordChatterPresence,
  saveChatterProfile,
  unflushViewer,
} from './viewerIdentity';

function reset() {
  db.exec('delete from chatters');
  db.exec('delete from ignored_logins');
  db.exec('delete from chat_messages');
  db.exec('delete from viewer_profiles');
}

function chatter(login: string) {
  return db.prepare('select * from chatters where login = ?').get(login) as
    | Record<string, unknown>
    | undefined;
}

beforeEach(reset);

describe('recordChatterPresence', () => {
  test('records a lurker who has never typed', () => {
    recordChatterPresence([{ userId: '42', userLogin: 'LurkerBob', userName: 'LurkerBob' }]);

    const row = chatter('lurkerbob');
    expect(row).not.toBeNull();
    expect(row!.message_count).toBe(0);
    expect(row!.twitch_user_id).toBe('42');
    expect(row!.last_seen_at).toBeTruthy();
  });

  test('lowercases the login so presence and chat agree on one key', () => {
    recordChatterPresence([{ userId: '1', userLogin: 'MixedCase', userName: 'MixedCase' }]);
    expect(chatter('mixedcase')).not.toBeNull();
    expect(chatter('MixedCase')).toBeNull();
  });

  test('never resets an existing chatter\'s message count', () => {
    db.prepare('insert into chatters (login, first_seen_at, message_count) values (?, ?, ?)')
      .run('regular', '2026-01-01T00:00:00Z', 17);

    recordChatterPresence([{ userId: '7', userLogin: 'regular', userName: 'Regular' }]);

    const row = chatter('regular');
    expect(row!.message_count).toBe(17);
    expect(row!.first_seen_at).toBe('2026-01-01T00:00:00Z');
    // Presence still backfills the identity the row was missing.
    expect(row!.twitch_user_id).toBe('7');
  });

  test('a flushed login is not recreated by presence', () => {
    flushViewer('spambot');
    recordChatterPresence([{ userId: '9', userLogin: 'spambot', userName: 'SpamBot' }]);
    expect(chatter('spambot')).toBeNull();
  });

  test('is idempotent across repeated polls', () => {
    const seen = [{ userId: '5', userLogin: 'steady', userName: 'Steady' }];
    recordChatterPresence(seen);
    recordChatterPresence(seen);
    recordChatterPresence(seen);
    const count = db.prepare('select count(*) as n from chatters').get() as { n: number };
    expect(count.n).toBe(1);
    expect(chatter('steady')!.message_count).toBe(0);
  });
});

// The trap this feature had to avoid. `chatters` doubles as the "has this person ever
// chatted" oracle behind the first-ever-chatter highlight, and it used to answer by
// row existence — so inserting lurkers would have silently killed the highlight for
// every lurker who later typed.
describe('first-ever-chatter highlight survives lurker rows', () => {
  test('a lurker present but never typing is not "seen before"', () => {
    recordChatterPresence([{ userId: '1', userLogin: 'quietone', userName: 'QuietOne' }]);
    expect(hasSeenChatterBefore('quietone')).toBe(false);
  });

  test('someone who has actually chatted is "seen before"', () => {
    db.prepare('insert into chatters (login, first_seen_at, message_count) values (?, ?, ?)')
      .run('talker', '2026-01-01T00:00:00Z', 1);
    expect(hasSeenChatterBefore('talker')).toBe(true);
  });

  test('an unknown login is not "seen before"', () => {
    expect(hasSeenChatterBefore('nobody')).toBe(false);
  });
});

describe('loginsMissingProfile', () => {
  test('returns only rows that have no profile yet', () => {
    recordChatterPresence([
      { userId: '1', userLogin: 'needsit', userName: 'needsit' },
      { userId: '2', userLogin: 'hasit', userName: 'hasit' },
    ]);
    saveChatterProfile({
      login: 'hasit',
      userId: '2',
      displayName: 'HasIt',
      profileImageUrl: 'https://img/hasit.png',
      accountCreatedAt: '2020-01-01T00:00:00Z',
    });

    expect(loginsMissingProfile()).toEqual(['needsit']);
  });

  test('caps the batch at the Helix per-request limit', () => {
    recordChatterPresence(
      Array.from({ length: 250 }, (_, i) => ({ userId: String(i), userLogin: `u${i}`, userName: `u${i}` })),
    );
    expect(loginsMissingProfile().length).toBe(100);
  });
});

describe('saveChatterProfile', () => {
  test('stores the profile and stamps when it was fetched', () => {
    recordChatterPresence([{ userId: '3', userLogin: 'someone', userName: 'someone' }]);
    saveChatterProfile({
      login: 'someone',
      userId: '3',
      displayName: 'SomeOne',
      profileImageUrl: 'https://img/someone.png',
      accountCreatedAt: '2019-05-05T00:00:00Z',
    });

    const row = chatter('someone')!;
    expect(row.display_name).toBe('SomeOne');
    expect(row.profile_image_url).toBe('https://img/someone.png');
    expect(row.account_created_at).toBe('2019-05-05T00:00:00Z');
    expect(row.profile_fetched_at).toBeTruthy();
    expect(row.missing_at).toBeNull();
  });

  test('clears a previous missing flag when the account comes back', () => {
    recordChatterPresence([{ userId: '4', userLogin: 'returner', userName: 'returner' }]);
    saveChatterProfile({ login: 'returner', missing: true });
    expect(chatter('returner')!.missing_at).toBeTruthy();

    saveChatterProfile({ login: 'returner', userId: '4', displayName: 'Returner' });
    expect(chatter('returner')!.missing_at).toBeNull();
  });

  test('marks an account Twitch no longer returns', () => {
    recordChatterPresence([{ userId: '6', userLogin: 'deleted', userName: 'deleted' }]);
    saveChatterProfile({ login: 'deleted', missing: true });

    const row = chatter('deleted')!;
    expect(row.missing_at).toBeTruthy();
    // The row survives — a deleted account is still part of the channel's history.
    expect(row.twitch_user_id).toBe('6');
  });
});

describe('flushViewer', () => {
  test('removes the roster row, the profile, and the message projection', () => {
    db.prepare('insert into chatters (login, first_seen_at, message_count) values (?, ?, ?)')
      .run('badbot', '2026-01-01T00:00:00Z', 40);
    db.prepare('insert into viewer_profiles (login, real_name, tags_json, note, created_at, updated_at) values (?,?,?,?,?,?)')
      .run('badbot', '', '[]', 'spam', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    db.prepare(`insert into chat_messages (id, channel, username, display_name, message, received_at)
                values (?,?,?,?,?,?)`)
      .run('m1', 'codeacula', 'badbot', 'BadBot', 'buy followers', '2026-01-01T00:00:00Z');

    const removed = flushViewer('badbot');

    expect(chatter('badbot')).toBeNull();
    expect(db.prepare('select 1 from viewer_profiles where login = ?').get('badbot')).toBeNull();
    expect(db.prepare('select 1 from chat_messages where username = ?').get('badbot')).toBeNull();
    expect(removed.messages).toBe(1);
  });

  test('adds the login to the ignore list so chat cannot recreate it', () => {
    flushViewer('badbot');
    expect(isLoginIgnored('badbot')).toBe(true);
    expect(ignoredLogins().map(row => row.login)).toContain('badbot');
  });

  test('is case-insensitive', () => {
    flushViewer('BadBot');
    expect(isLoginIgnored('badbot')).toBe(true);
    expect(isLoginIgnored('BADBOT')).toBe(true);
  });

  test('flushing twice does not throw', () => {
    flushViewer('badbot');
    expect(() => flushViewer('badbot')).not.toThrow();
  });

  // The append-only ledger is what makes a flush auditable rather than destructive.
  test('leaves chat_events intact', () => {
    db.prepare(`insert into chat_events (id, type, channel, username, payload_json, occurred_at)
                values (?,?,?,?,?,?)`)
      .run('e1', 'message', 'codeacula', 'badbot', '{}', '2026-01-01T00:00:00Z');

    flushViewer('badbot');

    expect(db.prepare('select 1 from chat_events where username = ?').get('badbot')).not.toBeNull();
  });

  test('unflush lifts the ignore so the viewer can return', () => {
    flushViewer('badbot');
    unflushViewer('badbot');
    expect(isLoginIgnored('badbot')).toBe(false);

    recordChatterPresence([{ userId: '8', userLogin: 'badbot', userName: 'BadBot' }]);
    expect(chatter('badbot')).not.toBeNull();
  });
});
