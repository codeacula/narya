import { beforeEach, describe, expect, test } from 'bun:test';
import { db } from './db';
import {
  migrateLegacyAlerts,
  migrateLegacyCategoryModules,
  migrateLegacyChatbotCommands,
  migrateLegacyMediaIntoAssets,
  migrateLegacyRewardBindings,
} from './legacyMigration';

type AssetRow = { id: string; label: string; kind: string; sourceType: string; src: string; volume: number; enabled: number };

function assets(): AssetRow[] {
  return db.prepare(`
    select id, label, kind, source_type as sourceType, src, volume, enabled
    from media_assets order by src
  `).all() as AssetRow[];
}

function assetBySrc(src: string): AssetRow | undefined {
  return assets().find(asset => asset.src === src);
}

beforeEach(() => {
  for (const table of [
    'media_assets', 'sound_buttons', 'clip_buttons', 'reward_media', 'alert_settings',
    'category_module_reward_groups', 'category_module_games', 'category_modules',
    'viewer_reward_category_games', 'viewer_reward_categories',
    'automation_triggers', 'action_steps', 'actions',
    'chatbot_command_actions', 'chatbot_commands',
    'tts_reward_enabled',
  ]) {
    db.exec(`delete from ${table}`);
  }
  db.exec('delete from schema_migrations');
});

function addRewardGroup(id: string, name: string): void {
  db.prepare(`
    insert into viewer_reward_categories (id, name, enabled, created_at, updated_at) values (?, ?, 1, '', '')
  `).run(id, name);
}

function mapGameToGroup(gameId: string, gameName: string, groupId: string): void {
  db.prepare(`
    insert into viewer_reward_category_games (category_id, game_id, game_name, created_at) values (?, ?, ?, '')
  `).run(groupId, gameId, gameName);
}

function moduleRows() {
  return db.prepare(`
    select m.id, m.name,
           (select group_concat(g.game_id) from category_module_games g where g.module_id = m.id) as games,
           (select group_concat(r.group_id) from category_module_reward_groups r where r.module_id = m.id) as groups
    from category_modules m order by m.name
  `).all() as Array<{ id: string; name: string; games: string | null; groups: string | null }>;
}

describe('migrateLegacyMediaIntoAssets', () => {
  test('preserves sound and clip button ids, so anything already bound to one still resolves', () => {
    db.prepare('insert into sound_buttons (id, label, filename) values (?, ?, ?)').run('quack-1', 'Quack 1', '/sounds/quack.mp3');
    db.prepare('insert into clip_buttons (id, label, filename) values (?, ?, ?)').run('clip-abc', 'Dinosaur', '/clips/dinosaur.mp4');

    migrateLegacyMediaIntoAssets();

    expect(assetBySrc('/sounds/quack.mp3')?.id).toBe('quack-1');
    expect(assetBySrc('/clips/dinosaur.mp4')?.id).toBe('clip-abc');
  });

  test('infers kind and source type from the src', () => {
    db.prepare('insert into sound_buttons (id, label, filename) values (?, ?, ?)').run('s1', 'Local', '/sounds/a.mp3');
    db.prepare('insert into sound_buttons (id, label, filename) values (?, ?, ?)').run('s2', 'Remote', 'https://example.com/b.mp3');
    db.prepare('insert into clip_buttons (id, label, filename) values (?, ?, ?)').run('c1', 'Clip', '/clips/c.mp4');

    migrateLegacyMediaIntoAssets();

    expect(assetBySrc('/sounds/a.mp3')).toMatchObject({ kind: 'audio', sourceType: 'local' });
    expect(assetBySrc('https://example.com/b.mp3')).toMatchObject({ kind: 'audio', sourceType: 'remote' });
    expect(assetBySrc('/clips/c.mp4')).toMatchObject({ kind: 'video', sourceType: 'local' });
  });

  test('a legacy src whose file is gone becomes a disabled asset rather than being dropped', () => {
    db.prepare('insert into sound_buttons (id, label, filename) values (?, ?, ?)').run('gone', 'Missing', '/sounds/not-on-disk.mp3');

    migrateLegacyMediaIntoAssets();

    const asset = assetBySrc('/sounds/not-on-disk.mp3');
    expect(asset).toBeDefined();
    // Kept (so its label and any binding survive) but disabled, so it is visibly
    // broken instead of a reward that silently plays nothing.
    expect(asset?.enabled).toBe(0);
    expect(asset?.label).toBe('Missing');
  });

  test('deduplicates by src: a reward bound to a button-owned file reuses that asset', () => {
    db.prepare('insert into sound_buttons (id, label, filename) values (?, ?, ?)').run('shared', 'Shared', '/sounds/shared.mp3');
    db.prepare('insert into reward_media (reward_id, kind, src, volume, updated_at) values (?, ?, ?, ?, ?)')
      .run('reward-1', 'audio', '/sounds/shared.mp3', 0.5, '');

    migrateLegacyMediaIntoAssets();

    expect(assets().filter(asset => asset.src === '/sounds/shared.mp3')).toHaveLength(1);
    expect(assetBySrc('/sounds/shared.mp3')?.id).toBe('shared');
  });

  test('imports alert sound and clip effects', () => {
    db.prepare(`
      insert into alert_settings (kind, enabled, template, duration_ms, sound_src, sound_volume, clip_src, clip_volume, updated_at)
      values ('sub', 1, '', 6000, '/sounds/alert.mp3', 0.6, '/clips/alert.mp4', 0.7, '')
    `).run();

    migrateLegacyMediaIntoAssets();

    expect(assetBySrc('/sounds/alert.mp3')).toMatchObject({ kind: 'audio', volume: 0.6 });
    expect(assetBySrc('/clips/alert.mp4')).toMatchObject({ kind: 'video', volume: 0.7 });
  });

  test('is idempotent: a second run adds nothing and does not duplicate the operator Actions', () => {
    db.prepare('insert into sound_buttons (id, label, filename) values (?, ?, ?)').run('s1', 'One', '/sounds/a.mp3');
    db.prepare('insert into reward_media (reward_id, kind, src, volume, updated_at) values (?, ?, ?, ?, ?)')
      .run('r1', 'video', '/clips/b.mp4', 0.8, '');

    migrateLegacyMediaIntoAssets();
    const first = assets();
    migrateLegacyMediaIntoAssets();

    expect(assets()).toEqual(first);
  });
});

describe('migrateLegacyCategoryModules', () => {
  test('creates one module per mapped game, owning that game and its reward groups', () => {
    addRewardGroup('g-pz', 'Project Zomboid');
    mapGameToGroup('31339', 'Project Zomboid', 'g-pz');

    migrateLegacyCategoryModules();

    expect(moduleRows()).toEqual([
      { id: expect.any(String), name: 'Project Zomboid', games: '31339', groups: 'g-pz' },
    ]);
  });

  test('leaves an unmapped reward group unowned, so module switching never touches it', () => {
    // This is the operator's real shape: a per-game group plus an always-on "Clips"
    // group with no game mapping. The old auto-switch left unmapped groups alone; a
    // module that owned "Clips" would start disabling it on every category change.
    addRewardGroup('g-pz', 'Project Zomboid');
    addRewardGroup('g-clips', 'Clips');
    mapGameToGroup('31339', 'Project Zomboid', 'g-pz');

    migrateLegacyCategoryModules();

    const owned = db.prepare('select group_id as groupId from category_module_reward_groups').all() as Array<{ groupId: string }>;
    expect(owned.map(row => row.groupId)).toEqual(['g-pz']);
    expect(owned.some(row => row.groupId === 'g-clips')).toBe(false);
  });

  test('a group shared by two games is owned by both generated modules', () => {
    addRewardGroup('g-shared', 'Shared');
    mapGameToGroup('1', 'Game One', 'g-shared');
    mapGameToGroup('2', 'Game Two', 'g-shared');

    migrateLegacyCategoryModules();

    const rows = moduleRows();
    expect(rows).toHaveLength(2);
    expect(rows.every(row => row.groups === 'g-shared')).toBe(true);
    // …but each game still belongs to exactly one module, which the schema enforces.
    expect(rows.map(row => row.games).sort()).toEqual(['1', '2']);
  });

  test('is idempotent: a second run does not duplicate modules', () => {
    addRewardGroup('g-pz', 'Project Zomboid');
    mapGameToGroup('31339', 'Project Zomboid', 'g-pz');

    migrateLegacyCategoryModules();
    const first = moduleRows();
    migrateLegacyCategoryModules();

    expect(moduleRows()).toEqual(first);
  });
});

function addCommand(id: string, trigger: string, actions: Array<{ type: string; payload: unknown }>): void {
  db.prepare('insert into chatbot_commands (id, trigger, enabled, created_at, updated_at) values (?, ?, 1, ?, ?)')
    .run(id, trigger, '', '');
  actions.forEach((action, index) => {
    db.prepare(`
      insert into chatbot_command_actions (id, command_id, action_type, payload_json, enabled, position, created_at, updated_at)
      values (?, ?, ?, ?, 1, ?, '', '')
    `).run(crypto.randomUUID(), id, action.type, JSON.stringify(action.payload), index);
  });
}

function triggerFor(command: string) {
  const rows = db.prepare('select action_id as actionId, kind, enabled, config_json as configJson from automation_triggers').all() as
    Array<{ actionId: string; kind: string; enabled: number; configJson: string }>;
  return rows.find(row => (JSON.parse(row.configJson) as { command?: string }).command === command);
}

function stepsOf(actionId: string) {
  return db.prepare('select step_type as type, payload_json as payloadJson from action_steps where action_id = ? order by position')
    .all(actionId) as Array<{ type: string; payloadJson: string }>;
}

describe('migrateLegacyChatbotCommands', () => {
  test('a chat reply becomes a send_chat step, with {username} rewritten to {actor}', () => {
    addCommand('c1', '!lurk', [{ type: 'chat_reply', payload: { template: 'thanks for lurking, {username}' } }]);

    migrateLegacyChatbotCommands();

    const trigger = triggerFor('!lurk');
    expect(trigger?.kind).toBe('viewer_command');
    const steps = stepsOf(trigger!.actionId);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.type).toBe('send_chat');
    // The old renderer only knew {username}. Leaving it would print the literal token,
    // because the Action renderer deliberately preserves unknown tokens.
    expect(JSON.parse(steps[0]!.payloadJson)).toEqual({ template: 'thanks for lurking, {actor}', sender: 'bot' });
  });

  test('a sound step binds to the media asset that kept the sound button id', () => {
    db.prepare('insert into sound_buttons (id, label, filename) values (?, ?, ?)')
      .run('sound-42', 'Airhorn', '/sounds/airhorn.mp3');
    addCommand('c2', '!airhorn', [{ type: 'sound_play', payload: { soundId: 'sound-42' } }]);

    migrateLegacyMediaIntoAssets();
    migrateLegacyChatbotCommands();

    const steps = stepsOf(triggerFor('!airhorn')!.actionId);
    expect(steps[0]!.type).toBe('play_media');
    expect(JSON.parse(steps[0]!.payloadJson)).toEqual({ assetIds: ['sound-42'], selection: 'first' });
  });

  test('!ponder becomes an llm_response step fed by the text after the trigger word', () => {
    addCommand('ponder-llm-command', '!ponder', [{ type: 'llm_response', payload: {} }]);

    migrateLegacyChatbotCommands();

    const steps = stepsOf(triggerFor('!ponder')!.actionId);
    expect(steps[0]!.type).toBe('llm_response');
    expect(JSON.parse(steps[0]!.payloadJson)).toEqual({ template: '{input}' });
  });

  test('preserves step order across a multi-step command', () => {
    addCommand('c3', '!hype', [
      { type: 'chat_reply', payload: { template: 'HYPE' } },
      { type: 'obs_scene', payload: { sceneName: 'Hype Cam' } },
      { type: 'obs_transition', payload: {} },
    ]);

    migrateLegacyChatbotCommands();

    expect(stepsOf(triggerFor('!hype')!.actionId).map(step => step.type))
      .toEqual(['send_chat', 'obs_scene', 'obs_transition']);
  });

  test('is idempotent: a second run does not duplicate the command', () => {
    addCommand('c4', '!discord', [{ type: 'chat_reply', payload: { template: 'discord.gg/x' } }]);

    migrateLegacyChatbotCommands();
    migrateLegacyChatbotCommands();

    const triggers = db.prepare("select count(*) as count from automation_triggers").get() as { count: number };
    expect(triggers.count).toBe(1);
  });
});

function triggersOfKind(kind: string) {
  return (db.prepare('select action_id as actionId, kind, enabled, config_json as configJson from automation_triggers where kind = ?')
    .all(kind) as Array<{ actionId: string; kind: string; enabled: number; configJson: string }>);
}

describe('migrateLegacyRewardBindings', () => {
  test('a reward with media becomes a play_media action bound to the asset, keeping its volume', () => {
    db.prepare('insert into clip_buttons (id, label, filename) values (?, ?, ?)').run('c1', 'Dinosaur', '/clips/dinosaur.mp4');
    db.prepare('insert into reward_media (reward_id, kind, src, volume, updated_at) values (?, ?, ?, ?, ?)')
      .run('reward-1', 'video', '/clips/dinosaur.mp4', 1, '');

    migrateLegacyMediaIntoAssets();
    migrateLegacyRewardBindings();

    const triggers = triggersOfKind('reward');
    expect(triggers).toHaveLength(1);
    expect(JSON.parse(triggers[0]!.configJson)).toEqual({ rewardId: 'reward-1' });
    const steps = stepsOf(triggers[0]!.actionId);
    expect(steps[0]!.type).toBe('play_media');
    // The reward's own volume overrode the asset default before; dropping it would
    // quietly re-tune every migrated redeem.
    expect(JSON.parse(steps[0]!.payloadJson)).toEqual({ assetIds: ['c1'], selection: 'first', volume: 1 });
  });

  test('a TTS-enabled reward becomes a tts_speak step fed by the redemption input', () => {
    db.prepare('insert into tts_reward_enabled (reward_id) values (?)').run('reward-tts');

    migrateLegacyRewardBindings();

    const steps = stepsOf(triggersOfKind('reward')[0]!.actionId);
    expect(steps[0]!.type).toBe('tts_speak');
    expect(JSON.parse(steps[0]!.payloadJson)).toEqual({ template: '{input}' });
  });

  test('a reward with both media and TTS gets both steps in one action', () => {
    db.prepare('insert into sound_buttons (id, label, filename) values (?, ?, ?)').run('s1', 'Airhorn', '/sounds/airhorn.mp3');
    db.prepare('insert into reward_media (reward_id, kind, src, volume, updated_at) values (?, ?, ?, ?, ?)')
      .run('r', 'audio', '/sounds/airhorn.mp3', 0.8, '');
    db.prepare('insert into tts_reward_enabled (reward_id) values (?)').run('r');

    migrateLegacyMediaIntoAssets();
    migrateLegacyRewardBindings();

    expect(triggersOfKind('reward')).toHaveLength(1);
    expect(stepsOf(triggersOfKind('reward')[0]!.actionId).map(s => s.type)).toEqual(['play_media', 'tts_speak']);
  });

  test('is idempotent: a second run does not create a second trigger that would double-play the redeem', () => {
    db.prepare('insert into clip_buttons (id, label, filename) values (?, ?, ?)').run('c1', 'Dino', '/clips/dinosaur.mp4');
    db.prepare('insert into reward_media (reward_id, kind, src, volume, updated_at) values (?, ?, ?, ?, ?)')
      .run('reward-1', 'video', '/clips/dinosaur.mp4', 1, '');

    migrateLegacyMediaIntoAssets();
    migrateLegacyRewardBindings();
    migrateLegacyRewardBindings();

    expect(triggersOfKind('reward')).toHaveLength(1);
  });
});

function addAlert(kind: string, enabled: number, template: string, soundSrc: string | null, clipSrc: string | null): void {
  db.prepare(`
    insert into alert_settings (kind, enabled, template, duration_ms, sound_src, sound_volume, clip_src, clip_volume, updated_at)
    values (?, ?, ?, 6000, ?, 0.8, ?, 0.8, '')
  `).run(kind, enabled, template, soundSrc, clipSrc);
}

describe('migrateLegacyAlerts', () => {
  test('an alert becomes text plus its sound, with {user} rewritten and its tone preserved', () => {
    db.prepare('insert into sound_buttons (id, label, filename) values (?, ?, ?)').run('s1', 'Fanfare', '/sounds/fanfaire.mp3');
    addAlert('sub', 1, '{user} just subscribed! ({tier})', '/sounds/fanfaire.mp3', null);

    migrateLegacyMediaIntoAssets();
    migrateLegacyAlerts();

    const triggers = triggersOfKind('twitch_event');
    expect(triggers).toHaveLength(1);
    expect(triggers[0]!.enabled).toBe(1);
    expect(JSON.parse(triggers[0]!.configJson)).toEqual({ eventKind: 'sub' });

    const steps = stepsOf(triggers[0]!.actionId);
    expect(steps.map(s => s.type)).toEqual(['show_text', 'play_media']);
    expect(JSON.parse(steps[0]!.payloadJson)).toEqual({
      // {tier} already exists in TemplateContext; only {user} needed rewriting.
      template: '{actor} just subscribed! ({tier})',
      durationMs: 6000,
      style: 'banner',
      // Without the tone the migrated sub alert would lose its gold accent.
      tone: 'warning',
    });
    expect(JSON.parse(steps[1]!.payloadJson)).toEqual({ assetIds: ['s1'], selection: 'first', volume: 0.8 });
  });

  test('sound and clip become separate steps at delay 0, so they still start together', () => {
    db.prepare('insert into sound_buttons (id, label, filename) values (?, ?, ?)').run('s1', 'S', '/sounds/a.mp3');
    db.prepare('insert into clip_buttons (id, label, filename) values (?, ?, ?)').run('c1', 'C', '/clips/b.mp4');
    addAlert('raid', 1, '{user} raided!', '/sounds/a.mp3', '/clips/b.mp4');

    migrateLegacyMediaIntoAssets();
    migrateLegacyAlerts();

    const steps = db.prepare(`
      select step_type as type, delay_ms as delayMs from action_steps where action_id = ? order by position
    `).all(triggersOfKind('twitch_event')[0]!.actionId) as Array<{ type: string; delayMs: number }>;
    expect(steps.map(s => s.type)).toEqual(['show_text', 'play_media', 'play_media']);
    expect(steps.every(s => s.delayMs === 0)).toBe(true);
  });

  test('a disabled alert migrates as a disabled trigger rather than being dropped', () => {
    addAlert('follow', 0, '{user} followed!', null, null);

    migrateLegacyAlerts();

    const triggers = triggersOfKind('twitch_event');
    expect(triggers).toHaveLength(1);
    // Keeping it disabled preserves the operator's wording so it can be switched
    // back on; dropping it would silently lose their work.
    expect(triggers[0]!.enabled).toBe(0);
  });

  test('is idempotent: a second run does not double-fire the alert', () => {
    addAlert('cheer', 1, '{user} cheered {amount}!', null, null);

    migrateLegacyAlerts();
    migrateLegacyAlerts();

    expect(triggersOfKind('twitch_event')).toHaveLength(1);
  });
});
