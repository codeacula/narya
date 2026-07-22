import { beforeEach, describe, expect, mock, test } from 'bun:test';

type Emitted = { event: string; src?: string; text?: string };

/** Every broadcast the run produced. Cleared per case. */
const emitted: Emitted[] = [];

// Intercept the broadcast before anything imports it, so the modules under test bind
// to the spy. Static imports are hoisted above this, hence the dynamic imports below.
const realtime = await import('./realtime');
mock.module('./realtime', () => ({
  ...realtime,
  broadcast: (event: string, payload: unknown) => {
    const body = payload as { src?: string; text?: string };
    emitted.push({ event, src: body?.src, text: body?.text });
  },
}));

const { createAction } = await import('./actions');
const { initAutomation } = await import('./automation');
const { db } = await import('./db');
const { handleEventSubNotification } = await import('./eventsub');
const { migrateLegacyAlerts, migrateLegacyMediaIntoAssets, migrateLegacyRewardBindings } = await import('./legacyMigration');
const { RuntimeState } = await import('./runtime');
const { upsertTriggerOverride } = await import('./triggerOverrides');

/**
 * The migration's one unforgivable failure mode: a redeem or an alert firing twice,
 * once through the retired path and once through its new trigger. These exercise the
 * real EventSub handler end to end against migrated data, because a unit test of
 * either half in isolation cannot see the double.
 */

const REWARD_ID = 'reward-double-check';

beforeEach(() => {
  for (const table of [
    'automation_runs', 'trigger_overrides', 'automation_triggers', 'action_steps', 'actions',
    'media_assets', 'reward_media', 'alert_settings', 'clip_buttons', 'sound_buttons', 'stream_events',
  ]) {
    db.exec(`delete from ${table}`);
  }
  db.exec('delete from schema_migrations');
  emitted.length = 0;

  // The operator's real shape: a reward bound to a clip, and an enabled follow alert.
  db.prepare('insert into clip_buttons (id, label, filename) values (?, ?, ?)')
    .run('clip-dino', 'Dinosaur', '/clips/dinosaur.mp4');
  db.prepare('insert into reward_media (reward_id, kind, src, volume, updated_at) values (?, ?, ?, ?, ?)')
    .run(REWARD_ID, 'video', '/clips/dinosaur.mp4', 1, '');
  db.prepare(`
    insert into alert_settings (kind, enabled, template, duration_ms, sound_src, sound_volume, clip_src, clip_volume, updated_at)
    values ('follow', 1, '{user} just followed!', 6000, null, null, '/clips/dinosaur.mp4', 0.8, '')
  `).run();

  migrateLegacyMediaIntoAssets();
  migrateLegacyRewardBindings();
  migrateLegacyAlerts();
  initAutomation(new RuntimeState());
});

describe('after the migration, an event fires exactly once', () => {
  test('a redeem plays its media once, not once per system', async () => {
    await handleEventSubNotification(new RuntimeState(), 'channel.channel_points_custom_reward_redemption.add', {
      user_name: 'Sorlus', user_login: 'sorlus', reward: { id: REWARD_ID, title: 'Play a clip' },
    }, 'evt-redeem-1');

    const plays = emitted.filter(entry => entry.event === 'media:play');
    // Two would mean the redemption handler still plays the binding itself while the
    // reward trigger also runs — the clip would play twice on stream.
    expect(plays).toHaveLength(1);
    expect(plays[0]!.src).toBe('/clips/dinosaur.mp4');
  });

  test('a follow fires its migrated alert once, as overlay text plus its clip', async () => {
    await handleEventSubNotification(new RuntimeState(), 'channel.follow', {
      user_name: 'Sorlus', user_login: 'sorlus',
    }, 'evt-follow-1');

    // The retired alerts module broadcast `alert:show`; nothing may still do that.
    expect(emitted.filter(entry => entry.event === 'alert:show')).toHaveLength(0);
    expect(emitted.filter(entry => entry.event === 'overlay:text')).toHaveLength(1);
    expect(emitted.filter(entry => entry.event === 'media:play')).toHaveLength(1);
    expect(emitted.find(entry => entry.event === 'overlay:text')?.text).toBe('Sorlus just followed!');
  });

  test('a redelivered EventSub message does not replay the redeem', async () => {
    await handleEventSubNotification(new RuntimeState(), 'channel.channel_points_custom_reward_redemption.add', {
      user_name: 'Sorlus', user_login: 'sorlus', reward: { id: REWARD_ID, title: 'Play a clip' },
    }, 'evt-redeem-dupe');
    expect(emitted.filter(entry => entry.event === 'media:play')).toHaveLength(1);

    emitted.length = 0;
    // Same message id: Twitch redelivering, not a second redemption.
    await handleEventSubNotification(new RuntimeState(), 'channel.channel_points_custom_reward_redemption.add', {
      user_name: 'Sorlus', user_login: 'sorlus', reward: { id: REWARD_ID, title: 'Play a clip' },
    }, 'evt-redeem-dupe');
    expect(emitted.filter(entry => entry.event === 'media:play')).toHaveLength(0);
  });
});

describe('per-viewer overrides keep the exactly-once guarantee', () => {
  function migratedRewardTriggerId(): string {
    const row = db.prepare("select id from automation_triggers where kind = 'reward'").get() as { id: string };
    return row.id;
  }

  test('an overridden redeem broadcasts the override, not the base — once', async () => {
    // show_text instead of play_media so the assertion does not depend on files on disk.
    const special = createAction({
      name: 'Sorlus special', description: '', enabled: true,
      steps: [{ type: 'show_text', enabled: true, delayMs: 0, payload: { template: 'SORLUS SPECIAL', durationMs: 6000, style: 'banner' } }],
    });
    upsertTriggerOverride(migratedRewardTriggerId(), { login: 'sorlus', actionId: special.id, enabled: true, note: '' });

    await handleEventSubNotification(new RuntimeState(), 'channel.channel_points_custom_reward_redemption.add', {
      user_name: 'Sorlus', user_login: 'sorlus', reward: { id: REWARD_ID, title: 'Play a clip' },
    }, 'evt-override-1');

    expect(emitted.filter(entry => entry.event === 'media:play')).toHaveLength(0);
    const texts = emitted.filter(entry => entry.event === 'overlay:text');
    expect(texts).toHaveLength(1);
    expect(texts[0]!.text).toBe('SORLUS SPECIAL');

    // Redelivery of the same EventSub message must produce no alert output. (stream:event
    // still fires — eventsub.ts broadcasts the event-feed entry before the dedup gate,
    // which is pre-existing behavior outside this invariant.)
    emitted.length = 0;
    await handleEventSubNotification(new RuntimeState(), 'channel.channel_points_custom_reward_redemption.add', {
      user_name: 'Sorlus', user_login: 'sorlus', reward: { id: REWARD_ID, title: 'Play a clip' },
    }, 'evt-override-1');
    expect(emitted.filter(entry => entry.event === 'media:play' || entry.event === 'overlay:text')).toHaveLength(0);
  });

  test('a skipped override falls back to the base clip — exactly one media:play', async () => {
    // play_media on an asset id that exists in no catalog: the run rolls up skipped.
    const broken = createAction({
      name: 'Sorlus broken special', description: '', enabled: true,
      steps: [{ type: 'play_media', enabled: true, delayMs: 0, payload: { assetIds: ['no-such-asset'], selection: 'first' } }],
    });
    upsertTriggerOverride(migratedRewardTriggerId(), { login: 'sorlus', actionId: broken.id, enabled: true, note: '' });

    await handleEventSubNotification(new RuntimeState(), 'channel.channel_points_custom_reward_redemption.add', {
      user_name: 'Sorlus', user_login: 'sorlus', reward: { id: REWARD_ID, title: 'Play a clip' },
    }, 'evt-override-2');

    const plays = emitted.filter(entry => entry.event === 'media:play');
    expect(plays).toHaveLength(1);
    expect(plays[0]!.src).toBe('/clips/dinosaur.mp4');
  });
});
