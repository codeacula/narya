import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { db, dropStaleTriggerActions } from './db';

describe('automation_trigger_actions migration', () => {
  test('the join table and name column exist with the shipped shape', () => {
    const cols = db.prepare("pragma table_info('automation_trigger_actions')").all() as Array<{ name: string }>;
    expect(cols.map(c => c.name).sort()).toEqual(['action_id', 'enabled', 'position', 'trigger_id']);
    const triggerCols = db.prepare("pragma table_info('automation_triggers')").all() as Array<{ name: string }>;
    expect(triggerCols.some(c => c.name === 'name')).toBe(true);
  });

  test('the backfill copies action_id into one join row per trigger (insert or ignore)', () => {
    // Seed a legacy trigger row + an action it points to.
    db.prepare("insert into actions (id, name, description, enabled, created_at, updated_at) values ('act1','A','',1,'t','t')").run();
    db.prepare(`insert into automation_triggers (id, kind, action_id, module_id, enabled, config_json, global_cooldown_ms, user_cooldown_ms, created_at, updated_at)
      values ('trg1','manual','act1',null,1,'{"label":"x"}',0,0,'t','t')`).run();
    db.prepare('delete from automation_trigger_actions where trigger_id = ?').run('trg1');
    // Re-run the backfill statement directly (the runOnce already ran at import).
    db.exec("insert or ignore into automation_trigger_actions (trigger_id, action_id, position, enabled) select id, action_id, 0, 1 from automation_triggers");
    const rows = db.prepare('select action_id as actionId, position, enabled from automation_trigger_actions where trigger_id = ?').all('trg1');
    expect(rows).toEqual([{ actionId: 'act1', position: 0, enabled: 1 }]);
  });

  test('dropStaleTriggerActions drops a shape-broken table and clears the backfill ledger', () => {
    const scratch = new Database(':memory:');
    scratch.exec("create table automation_trigger_actions (trigger_id text, action_id text)"); // missing position/enabled/PK
    scratch.exec("create table schema_migrations (id text primary key, applied_at text)");
    scratch.exec("insert into schema_migrations values ('2026-07-trigger-actions-from-action-id','t')");
    expect(dropStaleTriggerActions(scratch)).toBe(true);
    expect(scratch.prepare("pragma table_info('automation_trigger_actions')").all()).toHaveLength(0);
    expect(scratch.prepare("select 1 from schema_migrations where id = '2026-07-trigger-actions-from-action-id'").get()).toBeNull();
  });
});
