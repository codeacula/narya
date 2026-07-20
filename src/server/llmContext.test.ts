import { beforeEach, expect, test } from 'bun:test';
import { db } from './db';
import {
  deleteInteractionsForLogin,
  loadInteractions,
  MAX_STORED_INTERACTIONS,
  recordInteraction,
} from './llmContext';
import { flushViewer } from './viewerIdentity';

beforeEach(() => {
  db.exec('delete from llm_interactions');
  db.exec('delete from ignored_logins');
});

test('an interaction round-trips', () => {
  recordInteraction('bob', 'why lurk', 'because rest is good');
  expect(loadInteractions('bob', 5)).toEqual([{ prompt: 'why lurk', reply: 'because rest is good' }]);
});

test('interactions come back oldest first so they read as a transcript', () => {
  recordInteraction('bob', 'first', 'one');
  recordInteraction('bob', 'second', 'two');
  recordInteraction('bob', 'third', 'three');
  expect(loadInteractions('bob', 5).map(turn => turn.prompt)).toEqual(['first', 'second', 'third']);
});

test('the limit takes the NEWEST turns, not the oldest', () => {
  recordInteraction('bob', 'first', 'one');
  recordInteraction('bob', 'second', 'two');
  recordInteraction('bob', 'third', 'three');
  expect(loadInteractions('bob', 2).map(turn => turn.prompt)).toEqual(['second', 'third']);
});

test('one viewer never sees another viewer turns', () => {
  recordInteraction('bob', 'bob asked', 'bob answered');
  recordInteraction('sue', 'sue asked', 'sue answered');
  expect(loadInteractions('bob', 5)).toEqual([{ prompt: 'bob asked', reply: 'bob answered' }]);
});

test('a zero limit reads nothing', () => {
  recordInteraction('bob', 'x', 'y');
  expect(loadInteractions('bob', 0)).toEqual([]);
});

test('lookup is case-insensitive, matching how logins are stored', () => {
  recordInteraction('Bob', 'x', 'y');
  expect(loadInteractions('BOB', 5)).toHaveLength(1);
});

test('storage is pruned to the cap on insert', () => {
  for (let i = 0; i < MAX_STORED_INTERACTIONS + 10; i += 1) {
    recordInteraction('bob', `prompt ${i}`, `reply ${i}`);
  }
  const stored = db.prepare('select count(*) as count from llm_interactions where login = ?').get('bob') as { count: number };
  expect(stored.count).toBe(MAX_STORED_INTERACTIONS);
  // Pruning must drop the OLDEST, so the newest turn survives.
  expect(loadInteractions('bob', 1)[0]!.prompt).toBe(`prompt ${MAX_STORED_INTERACTIONS + 9}`);
});

test('an empty login is neither stored nor read', () => {
  recordInteraction('', 'x', 'y');
  expect(db.prepare('select count(*) as count from llm_interactions').get()).toEqual({ count: 0 });
  expect(loadInteractions('', 5)).toEqual([]);
});

test('deleting by login reports how many rows went', () => {
  recordInteraction('bob', 'a', 'b');
  recordInteraction('bob', 'c', 'd');
  recordInteraction('sue', 'e', 'f');
  expect(deleteInteractionsForLogin('bob')).toBe(2);
  expect(loadInteractions('sue', 5)).toHaveLength(1);
});

test('an ignored login cannot record a new interaction', () => {
  // A flushed viewer's content must never re-enter LLM storage, even from an
  // llm_response step (or an in-flight request) that fires after the flush.
  db.exec("insert into ignored_logins (login, reason, created_at) values ('bob', '', '2026-07-20T00:00:00.000Z')");
  recordInteraction('bob', 'why lurk', 'because rest is good');
  expect(loadInteractions('bob', 5)).toEqual([]);
  // A viewer who is not ignored is unaffected.
  recordInteraction('sue', 'x', 'y');
  expect(loadInteractions('sue', 5)).toHaveLength(1);
});

test('flushing a viewer deletes their recorded interactions and reports the count', () => {
  db.exec("delete from ignored_logins where login = 'bob'");
  recordInteraction('bob', 'a', 'b');
  recordInteraction('bob', 'c', 'd');
  recordInteraction('sue', 'e', 'f');

  const result = flushViewer('bob');

  expect(result.interactions).toBe(2);
  expect(loadInteractions('bob', 5)).toEqual([]);
  // Another viewer's memory is untouched.
  expect(loadInteractions('sue', 5)).toHaveLength(1);
});
