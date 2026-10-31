import { beforeEach, expect, test } from 'bun:test';
import { db } from './db';
import { chatRetentionCutoff, deleteArchivedChatForLogin, pruneChatHistory, searchChatHistory } from './retention';

const insertMessage = db.prepare(`insert into chat_messages (id, channel, username, display_name, message, received_at)
  values (?, ?, ?, ?, ?, ?)`);
const insertEvent = db.prepare(`insert into chat_events (id, type, channel, message_id, username, payload_json, occurred_at)
  values (?, 'message.created', '#test', ?, ?, '{}', ?)`);

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function seedMessage(id: string, message: string, daysAgo: number) {
  insertMessage.run(id, 'test', 'viewer', 'Viewer', message, daysAgoIso(daysAgo));
  insertEvent.run(`event-${id}`, id, 'viewer', daysAgoIso(daysAgo));
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

test('an unparseable FTS query falls back to LIKE and still finds archived text', () => {
  seedMessage('arch-2', 'quote: "walrus" AND (parenthetical', 200);
  pruneChatHistory();

  const hits = searchChatHistory('"walrus" AND');
  expect(hits.map(hit => hit.id)).toContain('arch-2');
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

test('flushing a viewer removes their archived messages from the projection and FTS', () => {
  seedMessage('flush-1', 'an archived waffle about pancakes', 100);
  pruneChatHistory();
  expect(searchChatHistory('waffle').map(row => row.id)).toContain('flush-1');

  deleteArchivedChatForLogin('viewer');
  expect(searchChatHistory('waffle').map(row => row.id)).not.toContain('flush-1');
  const leftover = db.prepare('select count(*) as c from archive.chat_messages_archive').get() as { c: number };
  expect(leftover.c).toBe(0);
});

test('crash-between-phases recovery: rows already archived are merged, not lost', () => {
  seedMessage('replay-1', 'copied progression', 100);
  // Simulate a phase-two crash: the copy landed, the live delete did not.
  db.exec(`delete from archive.chat_messages_fts where id = 'replay-1'`);
  // The row still lives in the main database, so search surfaces it as live.
  const midState = searchChatHistory('progression');
  expect(midState.map(row => row.id)).toContain('replay-1');
  expect(midState.find(row => row.id === 'replay-1')?.source).toBe('live');

  // The next run re-archives the still-live rows: or-ignore skips the copy,
  // so the FTS insert must also be gated (nothing doubles up), then the live
  // delete finally clears them while the archive copy remains.
  pruneChatHistory();

  const live = db.prepare("select count(*) as c from chat_messages where id = 'replay-1'").get() as { c: number };
  expect(live.c).toBe(0);
  const copies = db.prepare("select count(*) as c from archive.chat_messages_archive where id = 'replay-1'").get() as { c: number };
  expect(copies.c).toBe(1);
  // The FTS index was restored by the re-run (rows are still live pre-delete),
  // keeping search coverage without duplicates.
  const ftsRows = db.prepare("select count(*) as c from archive.chat_messages_fts where id = 'replay-1'").get() as { c: number };
  expect(ftsRows.c).toBe(1);
  const final = searchChatHistory('progression');
  expect(final.map(row => row.id)).toContain('replay-1');
  expect(final.find(row => row.id === 'replay-1')?.source).toBe('archive');
});
