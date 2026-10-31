import { beforeEach, expect, test } from 'bun:test';
import { db } from './db';
import { chatRetentionCutoff, pruneChatHistory } from './retention';

interface ChatRow {
  id: string;
  message: string;
}

beforeEach(() => {
  db.exec('delete from chat_messages');
  db.exec('delete from chat_events');
});

test('prunes chat_messages and chat_events older than the cutoff', () => {
  const insertMessage = db.prepare(`insert into chat_messages (id, channel, username, display_name, message, received_at)
    values (?, ?, ?, ?, ?, ?)`);
  const insertEvent = db.prepare(`insert into chat_events (id, type, channel, message_id, username, payload_json, occurred_at)
    values (?, 'message.created', '#test', ?, ?, '{}', ?)`);

  const cutoff = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000);
  insertMessage.run('old-msg', 'test', 'viewer', 'Viewer', 'stale message', cutoff.toISOString());
  insertEvent.run('old-event', 'old-msg', 'viewer', cutoff.toISOString());

  const fresh = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
  insertMessage.run('fresh-msg', 'test', 'viewer', 'Viewer', 'fresh message', fresh.toISOString());
  insertEvent.run('fresh-event', 'fresh-msg', 'viewer', fresh.toISOString());

  const pruned = pruneChatHistory();
  expect(pruned).toBe(2);

  const remainingMessages = db
    .prepare('select id from chat_messages order by id')
    .all() as Array<ChatRow>;
  const remainingEvents = db.prepare('select id from chat_events order by id').all() as Array<{ id: string }>;
  expect(remainingMessages.map(r => r.id)).toEqual(['fresh-msg']);
  expect(remainingEvents.map(r => r.id)).toEqual(['fresh-event']);
});

test('a window-relative cutoff is stable', () => {
  const now = new Date('2026-10-31T12:00:00.000Z');
  expect(chatRetentionCutoff(now)).toBe('2026-08-02T12:00:00.000Z');
});

test('an empty database prunes nothing', () => {
  expect(pruneChatHistory()).toBe(0);
});
