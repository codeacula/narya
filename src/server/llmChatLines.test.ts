import { beforeEach, expect, test } from 'bun:test';
import { db } from './db';
import { recentChatLines } from './llmContext';

function insert(
  id: string,
  username: string,
  message: string,
  receivedAt: string,
  deletedAt: string | null = null,
  displayName = username,
) {
  db.prepare(`
    insert into chat_messages (id, channel, username, display_name, color, message, received_at, deleted_at)
    values (?, 'test', ?, ?, null, ?, ?, ?)
  `).run(id, username, displayName, message, receivedAt, deletedAt);
}

beforeEach(() => {
  db.exec('delete from chat_messages');
  db.exec('delete from ignored_logins');
});

test('lines come back oldest first', () => {
  insert('1', 'ann', 'first', '2026-07-20T10:00:00.000Z');
  insert('2', 'bo', 'second', '2026-07-20T10:00:01.000Z');
  expect(recentChatLines(5).map(line => line.message)).toEqual(['first', 'second']);
});

test('the limit takes the newest lines', () => {
  insert('1', 'ann', 'first', '2026-07-20T10:00:00.000Z');
  insert('2', 'bo', 'second', '2026-07-20T10:00:01.000Z');
  insert('3', 'cy', 'third', '2026-07-20T10:00:02.000Z');
  expect(recentChatLines(2).map(line => line.message)).toEqual(['second', 'third']);
});

test('a moderated message never reaches the prompt', () => {
  // Replaying a timed-out message into the model's context would resurrect exactly
  // the content moderation removed, and could put it back on stream in a reply.
  insert('1', 'ann', 'fine', '2026-07-20T10:00:00.000Z');
  insert('2', 'troll', 'removed', '2026-07-20T10:00:01.000Z', '2026-07-20T10:00:02.000Z');
  expect(recentChatLines(5).map(line => line.message)).toEqual(['fine']);
});

test('a flushed viewer never reaches the prompt', () => {
  // chat.ts still inserts an ignored login's messages (only the roster summary is
  // gated), so without this filter a flushed viewer's content would feed the model.
  db.exec("insert into ignored_logins (login, reason, created_at) values ('troll', '', '2026-07-20T10:00:00.000Z')");
  insert('1', 'ann', 'fine', '2026-07-20T10:00:00.000Z');
  insert('2', 'troll', 'flushed', '2026-07-20T10:00:01.000Z');
  expect(recentChatLines(5).map(line => line.message)).toEqual(['fine']);
});

test('a zero limit reads nothing', () => {
  insert('1', 'ann', 'first', '2026-07-20T10:00:00.000Z');
  expect(recentChatLines(0)).toEqual([]);
});

test('the display name is preferred over the login', () => {
  insert('1', 'ann', 'hi', '2026-07-20T10:00:00.000Z', null, 'AnnTheGreat');
  expect(recentChatLines(5)[0]!.display).toBe('AnnTheGreat');
});

test('an empty display name falls back to the login', () => {
  insert('1', 'ann', 'hi', '2026-07-20T10:00:00.000Z', null, '');
  expect(recentChatLines(5)[0]!.display).toBe('ann');
});
