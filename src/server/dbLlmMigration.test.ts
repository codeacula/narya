import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { dropStaleLlmInteractions } from './db';

const OLD_SCHEMA = `
  create table llm_interactions (
    id text primary key,
    login text not null,
    prompt text not null,
    reply text not null,
    created_at text not null
  );
`;

const NEW_SCHEMA = `
  create table llm_interactions (
    seq integer primary key autoincrement,
    login text not null,
    prompt text not null,
    reply text not null,
    created_at text not null
  );
`;

function columnNames(database: Database): string[] {
  return (database.prepare("PRAGMA table_info('llm_interactions')").all() as Array<{ name: string }>)
    .map(column => column.name);
}

test('the old id-keyed table is dropped so the seq schema can be recreated', () => {
  const database = new Database(':memory:');
  database.exec(OLD_SCHEMA);

  expect(dropStaleLlmInteractions(database)).toBe(true);
  // Gone, so the caller's `create table if not exists` rebuilds it with seq.
  expect(columnNames(database)).toEqual([]);
});

test('a table that already has seq is left untouched', () => {
  const database = new Database(':memory:');
  database.exec(NEW_SCHEMA);
  database.exec("insert into llm_interactions (login, prompt, reply, created_at) values ('bob','a','b','2026-07-20T00:00:00.000Z')");

  expect(dropStaleLlmInteractions(database)).toBe(false);
  expect(columnNames(database)).toContain('seq');
  // A migrated table keeps its rows — the guard must not touch it.
  const count = database.prepare('select count(*) as count from llm_interactions').get() as { count: number };
  expect(count.count).toBe(1);
});

test('a fresh database with no such table is a no-op', () => {
  const database = new Database(':memory:');
  expect(dropStaleLlmInteractions(database)).toBe(false);
});

test('the migration is idempotent across repeated boots', () => {
  const database = new Database(':memory:');
  database.exec(OLD_SCHEMA);

  expect(dropStaleLlmInteractions(database)).toBe(true);
  database.exec(NEW_SCHEMA); // the caller's create-if-not-exists step
  // Second boot: already migrated, nothing to do.
  expect(dropStaleLlmInteractions(database)).toBe(false);
  expect(columnNames(database)).toContain('seq');
});
