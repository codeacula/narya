import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { dropStaleTriggerOverrides } from './db';

/** A plausible mid-edit shape the operator's bun --watch could have persisted. */
const STALE_SCHEMA = `
  create table trigger_overrides (
    id text primary key,
    trigger_id text not null,
    login text not null
  );
`;

const SHIPPED_SCHEMA = `
  create table trigger_overrides (
    id text primary key,
    trigger_id text not null,
    login text not null,
    action_id text not null,
    enabled integer not null default 1,
    note text not null default '',
    created_at text not null,
    updated_at text not null,
    unique (trigger_id, login)
  );
`;

function columnNames(database: Database): string[] {
  return (database.prepare("PRAGMA table_info('trigger_overrides')").all() as Array<{ name: string }>)
    .map(column => column.name);
}

test('a stale-shaped table is dropped so the shipped DDL can recreate it', () => {
  const database = new Database(':memory:');
  database.exec(STALE_SCHEMA);

  expect(dropStaleTriggerOverrides(database)).toBe(true);
  expect(columnNames(database)).toEqual([]);
});

test('the shipped shape is left untouched, rows intact', () => {
  const database = new Database(':memory:');
  database.exec(SHIPPED_SCHEMA);
  database.exec(`
    insert into trigger_overrides (id, trigger_id, login, action_id, enabled, note, created_at, updated_at)
    values ('o1', 't1', 'sorlus', 'a1', 1, '', '2026-07-22T00:00:00.000Z', '2026-07-22T00:00:00.000Z')
  `);

  expect(dropStaleTriggerOverrides(database)).toBe(false);
  expect(columnNames(database)).toContain('action_id');
  expect(database.prepare('select count(*) as n from trigger_overrides').get()).toEqual({ n: 1 });
});

test('an absent table is a no-op', () => {
  expect(dropStaleTriggerOverrides(new Database(':memory:'))).toBe(false);
});
