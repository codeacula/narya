import { beforeEach, describe, expect, test } from 'bun:test';
import { backfillProfiles, fetchAllChatters, type TwitchFetcher } from './chatters';
import { db } from './db';
import { recordChatterPresence, saveChatterProfile } from './viewerIdentity';

const credentials = {
  clientId: 'cid',
  authorization: 'Bearer t',
  broadcasterId: '12345',
} as unknown as Parameters<typeof fetchAllChatters>[0];

/**
 * A fetcher that replays canned JSON bodies in order and records the URLs it saw.
 * The last body repeats, so an endless-cursor page can be supplied once.
 */
function fakeFetcher(bodies: unknown[]) {
  const urls: string[] = [];
  let call = 0;
  const fetcher: TwitchFetcher = async (url: string) => {
    urls.push(url);
    const body = bodies[Math.min(call, bodies.length - 1)];
    call += 1;
    return { json: async () => body } as Response;
  };
  return Object.assign(fetcher, { urls });
}

function page(users: Array<[string, string]>, cursor?: string, total?: number) {
  return {
    data: users.map(([id, login]) => ({ user_id: id, user_login: login, user_name: login })),
    total,
    pagination: cursor ? { cursor } : {},
  };
}

function chatterRow(login: string) {
  return db.prepare('select * from chatters where login = ?').get(login) as Record<string, unknown> | null;
}

beforeEach(() => {
  db.exec('delete from chatters');
  db.exec('delete from ignored_logins');
});

describe('fetchAllChatters', () => {
  test('follows the pagination cursor across pages', async () => {
    const fetcher = fakeFetcher([
      page([['1', 'alice']], 'cur1', 3),
      page([['2', 'bob']], 'cur2', 3),
      page([['3', 'carol']], undefined, 3),
    ]);

    const result = await fetchAllChatters(credentials, fetcher);

    expect(result.chatters.map(c => c.userLogin)).toEqual(['alice', 'bob', 'carol']);
    expect(result.total).toBe(3);
    expect(result.truncated).toBe(false);
    expect(fetcher.urls).toHaveLength(3);
  });

  test('sends the cursor as `after` only after the first page', async () => {
    const fetcher = fakeFetcher([page([['1', 'alice']], 'cur1'), page([['2', 'bob']])]);
    await fetchAllChatters(credentials, fetcher);

    expect(fetcher.urls[0]).not.toContain('after=');
    expect(fetcher.urls[1]).toContain('after=cur1');
  });

  test('sends the broadcaster as its own moderator, which the scope requires', async () => {
    const fetcher = fakeFetcher([page([])]);
    await fetchAllChatters(credentials, fetcher);

    expect(fetcher.urls[0]).toContain('broadcaster_id=12345');
    expect(fetcher.urls[0]).toContain('moderator_id=12345');
  });

  // The bug this replaced: one page requested, the cursor typed and then dropped, so
  // a channel with more than a page of chatters silently lost the remainder.
  test('does not stop while a cursor remains', async () => {
    const fetcher = fakeFetcher([page([['1', 'alice']], 'more'), page([['2', 'bob']])]);
    const result = await fetchAllChatters(credentials, fetcher);
    expect(result.chatters).toHaveLength(2);
  });

  // A cursor that never clears must not spin forever against Helix.
  test('stops at the page cap and reports truncation rather than claiming completeness', async () => {
    const endless = fakeFetcher([page([['1', 'alice']], 'never-ends', 99999)]);
    const result = await fetchAllChatters(credentials, endless);

    expect(endless.urls.length).toBe(10);
    expect(result.truncated).toBe(true);
    expect(result.total).toBe(99999);
    expect(result.chatters.length).toBeLessThan(result.total);
  });

  test('an empty channel yields no chatters and no error', async () => {
    const result = await fetchAllChatters(credentials, fakeFetcher([{ data: [], total: 0 }]));
    expect(result.chatters).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.truncated).toBe(false);
  });

  test('falls back to the row count when Helix omits a total', async () => {
    const result = await fetchAllChatters(credentials, fakeFetcher([page([['1', 'a'], ['2', 'b']])]));
    expect(result.total).toBe(2);
  });
});

describe('backfillProfiles', () => {
  test('requests only the logins missing a profile, and saves what comes back', async () => {
    recordChatterPresence([
      { userId: '1', userLogin: 'needsit', userName: 'needsit' },
      { userId: '2', userLogin: 'hasit', userName: 'hasit' },
    ]);
    saveChatterProfile({ login: 'hasit', userId: '2', displayName: 'HasIt' });

    const fetcher = fakeFetcher([{
      data: [{
        id: '1',
        login: 'needsit',
        display_name: 'NeedsIt',
        profile_image_url: 'https://img/needsit.png',
        created_at: '2018-03-04T00:00:00Z',
      }],
    }]);

    const result = await backfillProfiles(credentials, fetcher);

    expect(fetcher.urls[0]).toContain('login=needsit');
    expect(fetcher.urls[0]).not.toContain('login=hasit');
    expect(result).toEqual({ resolved: 1, missing: 0 });

    const row = chatterRow('needsit')!;
    expect(row.display_name).toBe('NeedsIt');
    expect(row.profile_image_url).toBe('https://img/needsit.png');
    expect(row.account_created_at).toBe('2018-03-04T00:00:00Z');
  });

  // Helix returns only the accounts it knows: a renamed, deleted, or banned login is
  // simply absent from the response rather than reported as an error.
  test('marks an asked-for login that Twitch did not return', async () => {
    recordChatterPresence([
      { userId: '1', userLogin: 'alive', userName: 'alive' },
      { userId: '2', userLogin: 'gone', userName: 'gone' },
    ]);

    const fetcher = fakeFetcher([{
      data: [{ id: '1', login: 'alive', display_name: 'Alive', profile_image_url: '', created_at: '2019-01-01T00:00:00Z' }],
    }]);

    const result = await backfillProfiles(credentials, fetcher);

    expect(result).toEqual({ resolved: 1, missing: 1 });
    expect(chatterRow('gone')!.missing_at).toBeTruthy();
    expect(chatterRow('alive')!.missing_at).toBeNull();
    // The row survives being marked — a dead account is still part of the history.
    expect(chatterRow('gone')).not.toBeNull();
  });

  test('a marked login is not re-requested on the next pass', async () => {
    recordChatterPresence([{ userId: '2', userLogin: 'gone', userName: 'gone' }]);

    const first = fakeFetcher([{ data: [] }]);
    await backfillProfiles(credentials, first);
    expect(first.urls[0]).toContain('login=gone');

    const second = fakeFetcher([{ data: [] }]);
    const result = await backfillProfiles(credentials, second);
    expect(second.urls).toHaveLength(0);
    expect(result).toEqual({ resolved: 0, missing: 0 });
  });

  test('does not call Twitch at all when nothing is missing a profile', async () => {
    const fetcher = fakeFetcher([{ data: [] }]);
    const result = await backfillProfiles(credentials, fetcher);

    expect(fetcher.urls).toHaveLength(0);
    expect(result).toEqual({ resolved: 0, missing: 0 });
  });

  test('never asks for more logins than Helix accepts in one request', async () => {
    recordChatterPresence(
      Array.from({ length: 250 }, (_, i) => ({ userId: String(i), userLogin: `u${i}`, userName: `u${i}` })),
    );

    const fetcher = fakeFetcher([{ data: [] }]);
    await backfillProfiles(credentials, fetcher);

    const asked = new URL(fetcher.urls[0]).searchParams.getAll('login');
    expect(asked).toHaveLength(100);
  });

  test('a profile fetch that throws leaves the rows retryable', async () => {
    recordChatterPresence([{ userId: '1', userLogin: 'later', userName: 'later' }]);
    const boom = (async () => { throw new Error('Twitch 500'); }) as TwitchFetcher;

    await expect(backfillProfiles(credentials, boom)).rejects.toThrow('Twitch 500');
    // profile_fetched_at still null, so the next poll picks it up again.
    expect(chatterRow('later')!.profile_fetched_at).toBeNull();
  });
});
