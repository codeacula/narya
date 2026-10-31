import { beforeEach, expect, test } from 'bun:test';
import { db } from './db';
import { chatRetentionCutoff, pruneChatHistory, searchChatHistory } from './retention';

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

test('a database with no old rows archives nothing', () => {
  seedMessage('fresh-only', 'recent', 10);
  expect(pruneChatHistory()).toBe(0);
});
