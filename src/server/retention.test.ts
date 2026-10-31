import { beforeEach, expect, test } from 'bun:test';
import { db } from './db';
import {
  ARCHIVE_CANDIDATE_CAP,
  ARCHIVE_QUERY_SQL,
  archiveFtsFlushStatement,
  archivePathFor,
  archiveSearchStatement,
  chatRetentionCutoff,
  deleteArchivedChatForLogin,
  ensureArchiveSearchIndex,
  pruneChatHistory,
  searchChatHistory,
} from './retention';

const insertMessage = db.prepare(`insert into chat_messages (id, channel, username, display_name, message, received_at)
  values (?, ?, ?, ?, ?, ?)`);
const insertEvent = db.prepare(`insert into chat_events (id, type, channel, message_id, username, payload_json, occurred_at)
  values (?, 'message.created', '#test', ?, ?, '{}', ?)`);

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function seedMessage(id: string, message: string, daysAgo: number, username = 'viewer') {
  insertMessage.run(id, 'test', username, username, message, daysAgoIso(daysAgo));
  insertEvent.run(`event-${id}`, id, username, daysAgoIso(daysAgo));
}

function ids(hits: Array<{ id: string }>): string[] {
  return hits.map(hit => hit.id).sort();
}

beforeEach(() => {
  db.exec('delete from chat_messages');
  db.exec('delete from chat_events');
  db.exec('delete from archive.chat_messages_archive');
  db.exec('delete from archive.chat_events_archive');
  db.exec('delete from archive.chat_messages_fts');
});

test('archives chat_messages and chat_events older than the cutoff', () => {
  seedMessage('old-msg', 'stale message', 91);
  seedMessage('fresh-msg', 'fresh message', 10);

  const archived = pruneChatHistory();
  expect(archived).toBe(1);

  const remainingLive = db.prepare('select id from chat_messages order by id').all() as Array<{ id: string }>;
  expect(remainingLive.map(r => r.id)).toEqual(['fresh-msg']);

  const archivedMessage = db
    .prepare("select message from archive.chat_messages_archive where id = 'old-msg'")
    .get() as { message: string } | null;
  expect(archivedMessage?.message).toBe('stale message');

  const archivedEvents = db.prepare('select id from archive.chat_events_archive').all() as Array<{ id: string }>;
  expect(archivedEvents.map(r => r.id)).toEqual(['event-old-msg']);
});

test('archived messages come back through FTS search', () => {
  seedMessage('arch-1', 'the grumpy walrus flew west', 200);
  seedMessage('live-1', 'the grumpy walrus stayed home', 5);
  pruneChatHistory();

  const hits = searchChatHistory('walrus');
  expect(hits.some(hit => hit.id === 'arch-1' && hit.source === 'archive')).toBe(true);
  expect(hits.some(hit => hit.id === 'live-1' && hit.source === 'live')).toBe(true);
  const first = hits[0];
  const last = hits[hits.length - 1];
  expect(first && last && first.receivedAt >= last.receivedAt).toBe(true);
});

test('archive search matches substrings exactly like live search does', () => {
  // The same text on both sides of the cutoff must answer the same query the
  // same way; a whole-token FTS match used to miss the archived copy.
  seedMessage('sub-arch', 'the grumpy walrus flew west', 200);
  seedMessage('sub-live', 'the grumpy walrus stayed home', 5);
  pruneChatHistory();

  for (const query of ['walru', 'alrus fl', 'WALRUS', 'ru']) {
    const hits = searchChatHistory(query);
    const expected = query === 'alrus fl' ? ['sub-arch'] : ['sub-arch', 'sub-live'];
    expect(ids(hits)).toEqual(expected);
  }
});

test('FTS query syntax in the search box is literal text, not operators', () => {
  seedMessage('syn-1', 'quote: "walrus" AND (parenthetical', 200);
  seedMessage('syn-2', 'walrus without the operator text', 200);
  seedMessage('syn-3', 'username:viewer typed into chat', 200);
  pruneChatHistory();

  // As FTS syntax these would match syn-2 (AND/OR) or every row (column filter).
  expect(ids(searchChatHistory('"walrus" AND'))).toEqual(['syn-1']);
  expect(ids(searchChatHistory('walrus OR nothing'))).toEqual([]);
  expect(ids(searchChatHistory('username:viewer'))).toEqual(['syn-3']);
  expect(ids(searchChatHistory('(parenthetical'))).toEqual(['syn-1']);
});

test('repeated runs do not duplicate archived rows', () => {
  seedMessage('repeat-1', 'held once', 100);
  expect(pruneChatHistory()).toBe(1);
  expect(pruneChatHistory()).toBe(0);
  const count = db.prepare('select count(*) as c from archive.chat_messages_archive').get() as { c: number };
  expect(count.c).toBe(1);
});

test('a window-relative cutoff is stable', () => {
  const now = new Date('2026-10-31T12:00:00.000Z');
  expect(chatRetentionCutoff(now)).toBe('2026-08-02T12:00:00.000Z');
});

test('archived moderation state travels with the hit', () => {
  seedMessage('mod-1', 'a timed-out message', 100);
  // Simulate the moderation state chat.ts writes before archiving.
  db.prepare('update chat_messages set deleted_at = ?, deleted_reason = ?, moderation_event_id = ? where id = ?')
    .run(new Date().toISOString(), 'timeout: be nice', 'event-x', 'mod-1');
  pruneChatHistory();

  const hits = searchChatHistory('timed-out');
  const hit = hits.find(row => row.id === 'mod-1');
  expect(hit?.source).toBe('archive');
  expect(hit?.deletedAt).not.toBeNull();
  expect(hit?.deletedReason).toBe('timeout: be nice');
});

test('a database with no old rows archives nothing', () => {
  seedMessage('fresh-only', 'recent', 10);
  expect(pruneChatHistory()).toBe(0);
});

test('% and _ in the query are escaped, not wildcards', () => {
  seedMessage('pct-1', 'grow 50% stronger', 100);
  seedMessage('pct-2', 'grow ten times stronger', 100);
  pruneChatHistory();

  const hits = searchChatHistory('50%');
  expect(hits.map(row => row.id)).toContain('pct-1');
  expect(hits.map(row => row.id)).not.toContain('pct-2');
});

test('% and _ are literal in the archive too, on either side of the cutoff', () => {
  seedMessage('wild-arch-1', 'snake_case wins', 100);
  seedMessage('wild-arch-2', 'snakeXcase loses', 100);
  seedMessage('wild-live-1', 'snake_case wins live', 5);
  seedMessage('wild-live-2', 'snakeXcase loses live', 5);
  pruneChatHistory();

  expect(ids(searchChatHistory('snake_case'))).toEqual(['wild-arch-1', 'wild-live-1']);
  expect(ids(searchChatHistory('%'))).toEqual([]);
});

test('a flush removes exactly that login from the archive, never a lookalike', () => {
  // `_` is legal in a Twitch login and is a LIKE wildcard (coolxguy), and the
  // trigram phrase is a substring match (xcool_guyx): neither may be flushed
  // along with cool_guy. Two- and three-character logins take the other paths.
  seedMessage('flush-a', 'archived line from the flushed viewer', 100, 'cool_guy');
  seedMessage('flush-b', 'archived line from a wildcard lookalike', 100, 'coolxguy');
  seedMessage('flush-c', 'archived line from a substring lookalike', 100, 'xcool_guyx');
  seedMessage('flush-d', 'archived line from a short login', 100, 'ab');
  seedMessage('flush-e', 'archived line from a short-login lookalike', 100, 'abc');
  pruneChatHistory();

  deleteArchivedChatForLogin('Cool_Guy');
  deleteArchivedChatForLogin('ab');

  const survivors = ['flush-b', 'flush-c', 'flush-e'];
  const archived = db.prepare('select id from archive.chat_messages_archive order by id').all() as Array<{ id: string }>;
  expect(archived.map(row => row.id)).toEqual(survivors);
  const indexed = db.prepare('select id from archive.chat_messages_fts order by id').all() as Array<{ id: string }>;
  expect(indexed.map(row => row.id)).toEqual(survivors);
  expect(ids(searchChatHistory('archived line'))).toEqual(survivors);
});

test('the shipped archive search and flush statements are index-driven', () => {
  const planOf = (sql: string, ...params: Array<string | number>) => {
    // Finalized explicitly: an EXPLAIN of an FTS5 DELETE is left un-reset after
    // .all(), and the open statement then fails the next transaction's COMMIT
    // ("SQL statements in progress") in whichever test runs after this one.
    const statement = db.prepare(`explain query plan ${sql}`);
    try {
      return (statement.all(...params) as Array<{ detail: string }>).map(row => row.detail).join(' | ');
    } finally {
      statement.finalize();
    }
  };
  // FTS5 plans a MATCH from the operator alone (M), which — unlike a LIKE plan
  // (L) — is an index lookup for every bound phrase of three or more code
  // points; archiveSearchStatement routes everything shorter to the scan.
  expect(planOf(ARCHIVE_QUERY_SQL.countCandidates, 'message : "walrus"', 5000)).toMatch(/VIRTUAL TABLE INDEX 0:M/);
  expect(planOf(ARCHIVE_QUERY_SQL.searchIndexed, 'message : "walrus"', '%walrus%', 50))
    .toMatch(/^SCAN f VIRTUAL TABLE INDEX 0:M\d* \| SEARCH a USING INDEX sqlite_autoindex_chat_messages_archive_1 \(id=\?\)/);
  expect(planOf(ARCHIVE_QUERY_SQL.searchScan, '%gg%', 50))
    .toContain('SCAN archive.chat_messages_archive USING INDEX idx_chat_messages_archive_received_at');
  expect(planOf(ARCHIVE_QUERY_SQL.searchScan, '%gg%', 50)).not.toContain('TEMP B-TREE');
  expect(planOf(ARCHIVE_QUERY_SQL.flushArchive, 'cool_guy'))
    .toContain('USING INDEX idx_chat_messages_archive_username');
  expect(planOf(ARCHIVE_QUERY_SQL.flushFtsIndexed, 'username : "cool_guy"', 'cool_guy'))
    .toMatch(/VIRTUAL TABLE INDEX 0:M/);
});

test('short queries, including multi-unit emoji, still find archived rows', () => {
  // A trigram phrase under three code points matches nothing, so these must
  // take the scan path. 😀😀 is two code points but four UTF-16 units.
  seedMessage('short-1', 'gg wp 😀😀 ok', 200);
  seedMessage('short-2', 'nothing to see', 210);
  seedMessage('short-3', 'oo, newer', 150);
  pruneChatHistory();

  expect(ids(searchChatHistory('gg'))).toEqual(['short-1']);
  expect(ids(searchChatHistory('😀😀'))).toEqual(['short-1']);
  expect(ids(searchChatHistory('%'))).toEqual([]);
  expect(ids(searchChatHistory('o'))).toEqual(['short-1', 'short-2', 'short-3']);
  // The walk is newest-first, so a page of one is the newest match.
  expect(searchChatHistory('o', 1).map(hit => hit.id)).toEqual(['short-3']);
});

test('a query containing NUL answers like live search instead of failing to parse', () => {
  // Inside an FTS5 phrase a NUL reads as the end of the string ("unterminated
  // string"), so such a query must never reach the trigram path.
  seedMessage('nul-arch', 'ends with abcd', 200);
  seedMessage('nul-live', 'also ends with abcd', 5);
  pruneChatHistory();

  // SQLite's LIKE stops reading the pattern at the NUL, so live search treats
  // this as "ends with abcd"; the archive must give the same answer.
  const hits = searchChatHistory('abcd\0zzzz');
  expect(hits.map(hit => [hit.id, hit.source])).toEqual([['nul-live', 'live'], ['nul-arch', 'archive']]);
});

test('searches of three or more code points are answered through the trigram index', () => {
  // Routing probe: an archive row with no FTS entry is invisible to the indexed
  // path but found by the scan path. Results stay correct either way, so only
  // this tells a regression that sends every search down the slow scan.
  db.exec(`insert into archive.chat_messages_archive (id, channel, username, display_name, message, received_at)
    values ('probe-unindexed', 'test', 'viewer', 'viewer', 'walrus gg', ?)`, [daysAgoIso(200)]);

  expect(ids(searchChatHistory('walrus'))).toEqual([]);
  expect(ids(searchChatHistory('gg'))).toEqual(['probe-unindexed']);
});

test('a term with a full cap of trigram candidates walks newest-first instead of sorting them all', () => {
  // Only the FTS index is filled here, so the routing is visible: the indexed
  // path joins candidates to archive rows (there are none) and the scan path
  // reads archive rows directly (only the unindexed probe matches).
  const indexOnly = db.prepare(`insert into archive.chat_messages_fts (id, username, display_name, message, received_at)
    values (?, 'viewer', '', 'kappa spam', '2000-01-01')`);
  db.exec(`insert into archive.chat_messages_archive (id, channel, username, display_name, message, received_at)
    values ('probe-kappa', 'test', 'viewer', 'viewer', 'kappa probe', ?)`, [daysAgoIso(100)]);

  db.transaction(() => {
    for (let i = 0; i < ARCHIVE_CANDIDATE_CAP - 1; i += 1) indexOnly.run(`kappa-${i}`);
  })();
  expect(archiveSearchStatement('kappa')).toBe('searchIndexed');
  expect(ids(searchChatHistory('kappa', 1))).toEqual([]);

  indexOnly.run('kappa-last');
  expect(archiveSearchStatement('kappa')).toBe('searchScan');
  expect(ids(searchChatHistory('kappa', 1))).toEqual(['probe-kappa']);

  // Deciding "common" must cost at most the cap, however common the term is:
  // the count stops at the cap instead of visiting every match.
  for (let i = 0; i < 50; i += 1) indexOnly.run(`kappa-extra-${i}`);
  const counted = db.prepare(ARCHIVE_QUERY_SQL.countCandidates).get('message : "kappa"', ARCHIVE_CANDIDATE_CAP) as { count: number };
  expect(counted.count).toBe(ARCHIVE_CANDIDATE_CAP);

  // Rare and short terms are unaffected by the common one.
  expect(archiveSearchStatement('walrus')).toBe('searchIndexed');
  expect(archiveSearchStatement('ka')).toBe('searchScan');
});

test('a flush removes a login through the trigram index when it has a trigram', () => {
  expect(archiveFtsFlushStatement('cool_guy')).toBe('flushFtsIndexed');
  expect(archiveFtsFlushStatement('ab_')).toBe('flushFtsIndexed');
  expect(archiveFtsFlushStatement('ab')).toBe('flushFtsScan');
  expect(archiveFtsFlushStatement('a\0bc')).toBe('flushFtsScan');
});

test('the prune deletes walk the live cutoff index, not every archived id', () => {
  const plan = (sql: string) => {
    const statement = db.prepare(`explain query plan ${sql}`);
    try {
      return (statement.all('2026-01-01') as Array<{ detail: string }>).map(row => row.detail).join(' | ');
    } finally {
      statement.finalize();
    }
  };
  const messages = plan(ARCHIVE_QUERY_SQL.pruneLiveMessages);
  expect(messages).toContain('USING INDEX idx_chat_messages_received_at (received_at<?)');
  expect(messages).toContain('chat_messages_archive_1 (id=?)');
  expect(messages).not.toContain('IN-OPERATOR');
  const events = plan(ARCHIVE_QUERY_SQL.pruneLiveEvents);
  expect(events).toContain('USING INDEX idx_chat_events_occurred_at (occurred_at<?)');
  expect(events).toContain('chat_events_archive_1 (id=?)');
  expect(events).not.toContain('IN-OPERATOR');
});

test('archive search answers every query exactly as live search does (seeded differential fuzz)', () => {
  // Deterministic LCG so a failure reproduces. The alphabet is the hostile set:
  // LIKE wildcards, the escape char, FTS syntax, quotes, ASCII and non-ASCII case,
  // multi-unit emoji, and whitespace.
  let seed = 0x5eed;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const alphabet = ['a', 'b', 'A', 'B', '%', '_', '\\', '"', '*', ' ', 'é', 'É', '😀', 'x', 'OR', ':'];
  const word = (min: number, max: number) => {
    let out = '';
    const length = min + Math.floor(next() * (max - min + 1));
    for (let i = 0; i < length; i += 1) out += alphabet[Math.floor(next() * alphabet.length)];
    return out;
  };

  const messages = Array.from({ length: 120 }, () => word(3, 14));
  const queries = [...new Set(Array.from({ length: 250 }, () => word(1, 5)))];
  messages.forEach((text, index) => seedMessage(`fuzz-${index}`, text, 5));
  const live = queries.map(query => ids(searchChatHistory(query, 1000)));
  expect(live.some(hits => hits.length > 0)).toBe(true);

  db.exec('update chat_messages set received_at = ?', [daysAgoIso(200)]);
  db.exec('update chat_events set occurred_at = ?', [daysAgoIso(200)]);
  pruneChatHistory();
  expect((db.prepare('select count(*) as c from chat_messages').get() as { c: number }).c).toBe(0);

  const mismatches = queries
    .map((query, index) => ({ query, live: live[index], archive: ids(searchChatHistory(query, 1000)) }))
    .filter(result => JSON.stringify(result.live) !== JSON.stringify(result.archive));
  expect(mismatches).toEqual([]);
});

test('a pre-trigram FTS index is rebuilt in place from the archive table, once', () => {
  seedMessage('legacy-1', 'legacy tokenizer walrus', 100);
  seedMessage('legacy-2', 'second legacy line', 100);
  pruneChatHistory();

  // Recreate the index the way the first archive release shipped it.
  db.exec('drop table archive.chat_messages_fts');
  db.exec(`create virtual table archive.chat_messages_fts using fts5(
    id unindexed, username, display_name, message, received_at unindexed
  )`);
  db.exec(`insert into archive.chat_messages_fts (id, username, display_name, message, received_at)
    select id, username, display_name, message, received_at from archive.chat_messages_archive`);

  const ftsTable = () => db.prepare("select sql, rootpage from archive.sqlite_master where name = 'chat_messages_fts'")
    .all()[0] as { sql: string; rootpage: number };

  ensureArchiveSearchIndex();
  const afterRebuild = ftsTable();
  expect(afterRebuild.sql).toContain('trigram');

  // A second call must be a no-op, not a silent drop-and-refill on every boot:
  // a rebuild would erase this sentinel (it has no archive row to refill from).
  db.exec(`insert into archive.chat_messages_fts (id, username, display_name, message, received_at)
    values ('sentinel', 'nobody', '', 'sentinel row', '2000-01-01')`);
  ensureArchiveSearchIndex();
  expect(ftsTable()).toEqual(afterRebuild);
  const sentinel = db.prepare("select count(*) as c from archive.chat_messages_fts where id = 'sentinel'").get() as { c: number };
  expect(sentinel.c).toBe(1);
  db.exec("delete from archive.chat_messages_fts where id = 'sentinel'");

  const rows = db.prepare('select id, count(*) as c from archive.chat_messages_fts group by id order by id').all();
  expect(rows).toEqual([{ id: 'legacy-1', c: 1 }, { id: 'legacy-2', c: 1 }]);
  expect(ids(searchChatHistory('alrus'))).toEqual(['legacy-1']);
});

test('flushing a viewer removes their archived messages from the projection and FTS', () => {
  seedMessage('flush-1', 'an archived waffle about pancakes', 100);
  pruneChatHistory();
  expect(searchChatHistory('waffle').map(row => row.id)).toContain('flush-1');

  deleteArchivedChatForLogin('viewer');
  expect(searchChatHistory('waffle').map(row => row.id)).not.toContain('flush-1');
  const leftover = db.prepare('select count(*) as c from archive.chat_messages_archive').get() as { c: number };
  expect(leftover.c).toBe(0);
});

test('crash-between-phases recovery: rows already archived are merged, not lost or re-indexed', () => {
  seedMessage('replay-1', 'copied progression', 100);
  // Simulate a phase-two crash: phase one (copy + index) committed against the
  // archive, but the live delete never ran.
  db.exec(`insert into archive.chat_messages_archive (id, channel, username, display_name, message, received_at)
    select id, channel, username, display_name, message, received_at from chat_messages`);
  db.exec(`insert into archive.chat_messages_fts (id, username, display_name, message, received_at)
    select id, username, display_name, message, received_at from chat_messages`);
  // By the next run another row has crossed the cutoff, so this run does copy
  // something — which must not re-index the row that was already indexed.
  seedMessage('replay-2', 'newly old progression', 95);

  pruneChatHistory();

  const live = db.prepare("select count(*) as c from chat_messages where id like 'replay-%'").get() as { c: number };
  expect(live.c).toBe(0);
  const copies = db.prepare("select id, count(*) as c from archive.chat_messages_archive group by id order by id").all();
  expect(copies).toEqual([{ id: 'replay-1', c: 1 }, { id: 'replay-2', c: 1 }]);
  const ftsRows = db.prepare('select id, count(*) as c from archive.chat_messages_fts group by id order by id').all();
  expect(ftsRows).toEqual([{ id: 'replay-1', c: 1 }, { id: 'replay-2', c: 1 }]);
  const final = searchChatHistory('progression');
  expect(final.map(row => row.id).sort()).toEqual(['replay-1', 'replay-2']);
  expect(final.every(row => row.source === 'archive')).toBe(true);
});

test('the archive is a sibling named after the main database, one per database', () => {
  expect(archivePathFor('/srv/data/streamer-tools.sqlite')).toBe('/srv/data/streamer-tools.archive.sqlite');
  // A non-.sqlite name keeps its full basename, so scratch.sqlite and scratch.db
  // can never resolve to the same archive.
  expect(archivePathFor('/tmp/scratch.db')).toBe('/tmp/scratch.db.archive.sqlite');
  expect(archivePathFor('/tmp/scratch.sqlite')).not.toBe(archivePathFor('/tmp/scratch.db'));
});
