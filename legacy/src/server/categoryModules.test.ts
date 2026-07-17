import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { saveAppConfig } from './appConfig';
import {
  createCategoryModule,
  getCategoryModulesResponse,
  listCategoryModules,
  onCategorySignal,
  reconcileCategoryModules,
  resetCategoryModuleCoordinator,
  updateCategoryModule,
} from './categoryModules';
import { db } from './db';
import { HttpRouteError } from './http';
import { RuntimeState } from './runtime';

const GAME_ZOMBOID = '1001';
const GAME_ELITE = '1002';
const GAME_FACTORIO = '1003';
const GAME_UNKNOWN = '9999';

// --- Twitch stub -------------------------------------------------------------

type StubReward = { id: string; is_enabled: boolean; manageable: boolean; rejectUpdate?: boolean };
type PatchCall = { rewardId: string; enabled: boolean };

type TwitchStub = {
  rewards: Map<string, StubReward>;
  patches: PatchCall[];
  rewardListCalls: number;
  channelCalls: number;
  /** Live category returned by GET /helix/channels. */
  liveGameId: string | null;
  liveGameName: string | null;
  /** When set, GET /helix/channels fails with this status (an authoritative-lookup failure). */
  channelStatus: number;
  /** When set, reward-list GETs block on this promise — lets a transition be held in flight. */
  rewardListGate: Promise<void> | null;
};

let stub: TwitchStub;
let originalFetch: typeof globalThis.fetch;

function twitchRewardPayload(reward: StubReward) {
  return {
    id: reward.id,
    title: `Reward ${reward.id}`,
    prompt: '',
    cost: 100,
    is_enabled: reward.is_enabled,
    is_paused: false,
    is_in_stock: true,
    is_user_input_required: false,
    background_color: '#9147FF',
    image: null,
    default_image: {},
    should_redemptions_skip_request_queue: false,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function installTwitchStub() {
  originalFetch = globalThis.fetch;
  stub = {
    rewards: new Map(),
    patches: [],
    rewardListCalls: 0,
    channelCalls: 0,
    liveGameId: null,
    liveGameName: null,
    channelStatus: 200,
    rewardListGate: null,
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();

    if (url.pathname === '/helix/channels' && method === 'GET') {
      stub.channelCalls += 1;
      if (stub.channelStatus !== 200) {
        return jsonResponse({ message: 'Twitch is unavailable.' }, stub.channelStatus);
      }
      return jsonResponse({
        data: [{
          broadcaster_id: 'bid',
          game_id: stub.liveGameId ?? '',
          game_name: stub.liveGameName ?? '',
        }],
      });
    }

    if (url.pathname === '/helix/channel_points/custom_rewards' && method === 'GET') {
      stub.rewardListCalls += 1;
      if (stub.rewardListGate) await stub.rewardListGate;
      const onlyManageable = url.searchParams.get('only_manageable_rewards') === 'true';
      const rewards = [...stub.rewards.values()]
        .filter(reward => !onlyManageable || reward.manageable)
        .map(twitchRewardPayload);
      return jsonResponse({ data: rewards });
    }

    if (url.pathname === '/helix/channel_points/custom_rewards' && method === 'PATCH') {
      const rewardId = url.searchParams.get('id') ?? '';
      const body = JSON.parse(String(init?.body ?? '{}')) as { is_enabled?: boolean };
      const reward = stub.rewards.get(rewardId);
      if (!reward) return jsonResponse({ message: 'Unknown reward.' }, 404);
      if (reward.rejectUpdate) return jsonResponse({ message: 'Twitch rejected the update.' }, 500);
      stub.patches.push({ rewardId, enabled: body.is_enabled === true });
      reward.is_enabled = body.is_enabled === true;
      return jsonResponse({ data: [twitchRewardPayload(reward)] });
    }

    throw new Error(`Unexpected fetch in test: ${method} ${url.href}`);
  }) as typeof globalThis.fetch;
}

function enabledPatches(): string[] {
  return stub.patches.filter(patch => patch.enabled).map(patch => patch.rewardId).sort();
}

function disabledPatches(): string[] {
  return stub.patches.filter(patch => !patch.enabled).map(patch => patch.rewardId).sort();
}

function patchesFor(rewardIds: string[]): PatchCall[] {
  return stub.patches.filter(patch => rewardIds.includes(patch.rewardId));
}

// --- Seeding -----------------------------------------------------------------

function seedRewardGroup(groupId: string, name: string, rewards: StubReward[]) {
  const now = new Date().toISOString();
  db.prepare('insert or replace into viewer_reward_categories (id, name, enabled, created_at, updated_at) values (?, ?, 1, ?, ?)')
    .run(groupId, name, now, now);
  for (const reward of rewards) {
    stub.rewards.set(reward.id, reward);
    db.prepare('insert or replace into viewer_reward_category_members (reward_id, category_id, updated_at) values (?, ?, ?)')
      .run(reward.id, groupId, now);
  }
}

function reward(id: string, isEnabled: boolean, overrides: Partial<StubReward> = {}): StubReward {
  return { id, is_enabled: isEnabled, manageable: true, ...overrides };
}

function moduleById(id: string) {
  const found = listCategoryModules().find(module => module.id === id);
  if (!found) throw new Error(`module ${id} not found`);
  return found;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

async function waitFor(condition: () => boolean, label: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await new Promise(r => setTimeout(r, 5));
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

let state: RuntimeState;

beforeEach(() => {
  db.exec('delete from category_module_reward_groups');
  db.exec('delete from category_module_games');
  db.exec('delete from category_modules');
  db.exec('delete from viewer_reward_category_members');
  db.exec('delete from viewer_reward_category_games');
  db.exec('delete from viewer_reward_categories');
  db.exec('delete from stream_categories');
  resetCategoryModuleCoordinator();
  installTwitchStub();

  saveAppConfig({ twitchChannel: 'tester', twitchClientId: 'test-client-id' });

  state = new RuntimeState();
  state.broadcasterId = 'bid';
  state.runtimeUserToken = {
    accessToken: 'test-token',
    refreshToken: null,
    scopes: ['channel:manage:redemptions'],
    tokenType: 'bearer',
    expiresAtMs: Date.now() + 3_600_000,
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// --- Repository --------------------------------------------------------------

describe('category module repository', () => {
  test('a game cannot be claimed by two modules', () => {
    seedRewardGroup('grp-a', 'Zomboid Rewards', [reward('r1', false)]);
    seedRewardGroup('grp-b', 'Other Rewards', [reward('r2', false)]);

    createCategoryModule({
      name: 'Zomboid',
      enabled: true,
      games: [{ id: GAME_ZOMBOID, name: 'Project Zomboid' }],
      rewardGroupIds: ['grp-a'],
    });

    let thrown: unknown;
    try {
      createCategoryModule({
        name: 'Impostor',
        enabled: true,
        games: [{ id: GAME_ZOMBOID, name: 'Project Zomboid' }],
        rewardGroupIds: ['grp-b'],
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(HttpRouteError);
    expect((thrown as HttpRouteError).status).toBe(409);
    // The rejected module must not be half-created.
    expect(listCategoryModules().map(m => m.name)).toEqual(['Zomboid']);
  });

  test('a module can keep its own game on update', () => {
    seedRewardGroup('grp-a', 'Zomboid Rewards', [reward('r1', false)]);
    const created = createCategoryModule({
      name: 'Zomboid',
      enabled: true,
      games: [{ id: GAME_ZOMBOID, name: 'Project Zomboid' }],
      rewardGroupIds: ['grp-a'],
    });

    const updated = updateCategoryModule(created.id, {
      name: 'Zomboid (night)',
      enabled: true,
      games: [{ id: GAME_ZOMBOID, name: 'Project Zomboid' }, { id: GAME_FACTORIO, name: 'Factorio' }],
      rewardGroupIds: ['grp-a'],
    });

    expect(updated.name).toBe('Zomboid (night)');
    expect(updated.games.map(g => g.id).sort()).toEqual([GAME_ZOMBOID, GAME_FACTORIO].sort());
  });

  test('a reward group may be owned by several modules', () => {
    seedRewardGroup('grp-shared', 'Always On', [reward('shared-1', false)]);
    const first = createCategoryModule({
      name: 'Zomboid', enabled: true,
      games: [{ id: GAME_ZOMBOID, name: 'Project Zomboid' }], rewardGroupIds: ['grp-shared'],
    });
    const second = createCategoryModule({
      name: 'Elite', enabled: true,
      games: [{ id: GAME_ELITE, name: 'Elite: Dangerous' }], rewardGroupIds: ['grp-shared'],
    });

    expect(moduleById(first.id).rewardGroups.map(g => g.id)).toEqual(['grp-shared']);
    expect(moduleById(second.id).rewardGroups.map(g => g.id)).toEqual(['grp-shared']);
  });
});

// --- Coordinator -------------------------------------------------------------

describe('onCategorySignal', () => {
  test('an exact game match activates that module and enables its reward groups', async () => {
    seedRewardGroup('grp-zomboid', 'Zomboid', [reward('z1', false), reward('z2', false)]);
    const zomboid = createCategoryModule({
      name: 'Zomboid', enabled: true,
      games: [{ id: GAME_ZOMBOID, name: 'Project Zomboid' }], rewardGroupIds: ['grp-zomboid'],
    });

    await onCategorySignal(state, 'channel_update', GAME_ZOMBOID);

    expect(enabledPatches()).toEqual(['z1', 'z2']);
    expect(moduleById(zomboid.id).status).toBe('active');

    const response = getCategoryModulesResponse();
    expect(response.activeModuleId).toBe(zomboid.id);
    expect(response.activeGameId).toBe(GAME_ZOMBOID);
    expect(response.activeGameName).toBe('Project Zomboid');
    expect(response.lastSignalSource).toBe('channel_update');
  });

  test('switching category deactivates the outgoing module and activates the incoming one', async () => {
    seedRewardGroup('grp-zomboid', 'Zomboid', [reward('z1', false)]);
    seedRewardGroup('grp-elite', 'Elite', [reward('e1', false)]);
    const zomboid = createCategoryModule({
      name: 'Zomboid', enabled: true,
      games: [{ id: GAME_ZOMBOID, name: 'Project Zomboid' }], rewardGroupIds: ['grp-zomboid'],
    });
    const elite = createCategoryModule({
      name: 'Elite', enabled: true,
      games: [{ id: GAME_ELITE, name: 'Elite: Dangerous' }], rewardGroupIds: ['grp-elite'],
    });

    await onCategorySignal(state, 'stream_online', GAME_ZOMBOID);
    stub.patches = [];

    await onCategorySignal(state, 'channel_update', GAME_ELITE);

    expect(disabledPatches()).toEqual(['z1']);
    expect(enabledPatches()).toEqual(['e1']);
    expect(moduleById(zomboid.id).status).toBe('idle');
    expect(moduleById(elite.id).status).toBe('active');
    expect(getCategoryModulesResponse().activeModuleId).toBe(elite.id);
  });

  test('an unmatched category leaves no module active and disables module-owned groups', async () => {
    seedRewardGroup('grp-zomboid', 'Zomboid', [reward('z1', false)]);
    const zomboid = createCategoryModule({
      name: 'Zomboid', enabled: true,
      games: [{ id: GAME_ZOMBOID, name: 'Project Zomboid' }], rewardGroupIds: ['grp-zomboid'],
    });

    await onCategorySignal(state, 'channel_update', GAME_ZOMBOID);
    stub.patches = [];

    await onCategorySignal(state, 'channel_update', GAME_UNKNOWN);

    expect(disabledPatches()).toEqual(['z1']);
    expect(moduleById(zomboid.id).status).toBe('idle');
    const response = getCategoryModulesResponse();
    expect(response.activeModuleId).toBeNull();
    expect(response.activeGameId).toBe(GAME_UNKNOWN);
  });

  test('a null game id leaves no module active', async () => {
    seedRewardGroup('grp-zomboid', 'Zomboid', [reward('z1', false)]);
    createCategoryModule({
      name: 'Zomboid', enabled: true,
      games: [{ id: GAME_ZOMBOID, name: 'Project Zomboid' }], rewardGroupIds: ['grp-zomboid'],
    });

    await onCategorySignal(state, 'channel_update', GAME_ZOMBOID);
    stub.patches = [];

    await onCategorySignal(state, 'channel_update', null);

    expect(disabledPatches()).toEqual(['z1']);
    const response = getCategoryModulesResponse();
    expect(response.activeModuleId).toBeNull();
    expect(response.activeGameId).toBeNull();
  });

  test('a disabled module never activates', async () => {
    seedRewardGroup('grp-zomboid', 'Zomboid', [reward('z1', false)]);
    const zomboid = createCategoryModule({
      name: 'Zomboid', enabled: false,
      games: [{ id: GAME_ZOMBOID, name: 'Project Zomboid' }], rewardGroupIds: ['grp-zomboid'],
    });

    await onCategorySignal(state, 'channel_update', GAME_ZOMBOID);

    expect(enabledPatches()).toEqual([]);
    expect(moduleById(zomboid.id).status).toBe('idle');
    expect(getCategoryModulesResponse().activeModuleId).toBeNull();
  });

  test('a group owned by two modules is not disabled and re-enabled across a switch', async () => {
    seedRewardGroup('grp-shared', 'Always On', [reward('s1', false)]);
    seedRewardGroup('grp-zomboid', 'Zomboid Only', [reward('z1', false)]);
    seedRewardGroup('grp-elite', 'Elite Only', [reward('e1', false)]);

    createCategoryModule({
      name: 'Zomboid', enabled: true,
      games: [{ id: GAME_ZOMBOID, name: 'Project Zomboid' }],
      rewardGroupIds: ['grp-shared', 'grp-zomboid'],
    });
    createCategoryModule({
      name: 'Elite', enabled: true,
      games: [{ id: GAME_ELITE, name: 'Elite: Dangerous' }],
      rewardGroupIds: ['grp-shared', 'grp-elite'],
    });

    await onCategorySignal(state, 'stream_online', GAME_ZOMBOID);
    expect(enabledPatches()).toEqual(['s1', 'z1']);

    stub.patches = [];
    await onCategorySignal(state, 'channel_update', GAME_ELITE);

    // The shared group is owned by both modules: it must not be touched at all.
    expect(patchesFor(['s1'])).toEqual([]);
    expect(stub.rewards.get('s1')?.is_enabled).toBe(true);
    expect(disabledPatches()).toEqual(['z1']);
    expect(enabledPatches()).toEqual(['e1']);
  });
});

// --- Generation guard --------------------------------------------------------

describe('transition serialization', () => {
  function seedThreeModules() {
    seedRewardGroup('grp-a', 'A', [reward('a1', false)]);
    seedRewardGroup('grp-b', 'B', [reward('b1', false)]);
    seedRewardGroup('grp-c', 'C', [reward('c1', false)]);
    const a = createCategoryModule({
      name: 'A', enabled: true, games: [{ id: GAME_ZOMBOID, name: 'A Game' }], rewardGroupIds: ['grp-a'],
    });
    const b = createCategoryModule({
      name: 'B', enabled: true, games: [{ id: GAME_ELITE, name: 'B Game' }], rewardGroupIds: ['grp-b'],
    });
    const c = createCategoryModule({
      name: 'C', enabled: true, games: [{ id: GAME_FACTORIO, name: 'C Game' }], rewardGroupIds: ['grp-c'],
    });
    return { a, b, c };
  }

  test('a rapid A -> B -> C sequence settles on C', async () => {
    const { a, b, c } = seedThreeModules();

    await Promise.all([
      onCategorySignal(state, 'channel_update', GAME_ZOMBOID),
      onCategorySignal(state, 'channel_update', GAME_ELITE),
      onCategorySignal(state, 'channel_update', GAME_FACTORIO),
    ]);

    // Only C's reward may have been enabled; A's and B's transitions were superseded.
    expect(enabledPatches()).toEqual(['c1']);
    expect(stub.rewards.get('a1')?.is_enabled).toBe(false);
    expect(stub.rewards.get('b1')?.is_enabled).toBe(false);
    expect(stub.rewards.get('c1')?.is_enabled).toBe(true);

    expect(moduleById(a.id).status).toBe('idle');
    expect(moduleById(b.id).status).toBe('idle');
    expect(moduleById(c.id).status).toBe('active');
    expect(getCategoryModulesResponse().activeModuleId).toBe(c.id);
    expect(getCategoryModulesResponse().activeGameId).toBe(GAME_FACTORIO);
  });

  test('an older transition already in flight is discarded, not applied', async () => {
    const { a, c } = seedThreeModules();

    // Hold A's reward fetch open so A is genuinely mid-transition when B and C arrive.
    const gate = deferred();
    stub.rewardListGate = gate.promise;

    const first = onCategorySignal(state, 'channel_update', GAME_ZOMBOID);
    await waitFor(() => stub.rewardListCalls > 0, 'A to reach its Twitch reward fetch');

    const second = onCategorySignal(state, 'channel_update', GAME_ELITE);
    const third = onCategorySignal(state, 'channel_update', GAME_FACTORIO);

    gate.resolve();
    await Promise.all([first, second, third]);

    // A resolved last but must not have written A's reward state.
    expect(patchesFor(['a1']).filter(patch => patch.enabled)).toEqual([]);
    expect(stub.rewards.get('a1')?.is_enabled).toBe(false);
    expect(stub.rewards.get('c1')?.is_enabled).toBe(true);
    expect(moduleById(a.id).status).toBe('idle');
    expect(moduleById(c.id).status).toBe('active');
    expect(getCategoryModulesResponse().activeModuleId).toBe(c.id);
  });
});

// --- Degraded paths ----------------------------------------------------------

describe('degraded handling', () => {
  test('a read-only reward that needs a change degrades the module and retry recovers it', async () => {
    seedRewardGroup('grp-zomboid', 'Zomboid', [
      reward('z1', false),
      reward('z2', false, { manageable: false }),
    ]);
    const zomboid = createCategoryModule({
      name: 'Zomboid', enabled: true,
      games: [{ id: GAME_ZOMBOID, name: 'Project Zomboid' }], rewardGroupIds: ['grp-zomboid'],
    });

    await onCategorySignal(state, 'channel_update', GAME_ZOMBOID);

    // The manageable reward still flips; the read-only one cannot, so the module is degraded.
    expect(enabledPatches()).toEqual(['z1']);
    const degraded = moduleById(zomboid.id);
    expect(degraded.status).toBe('degraded');
    expect(degraded.statusDetail).toContain('read-only');

    // Operator grants the app control of the reward, then hits Retry.
    stub.rewards.get('z2')!.manageable = true;
    stub.liveGameId = GAME_ZOMBOID;
    stub.liveGameName = 'Project Zomboid';

    await reconcileCategoryModules(state);

    expect(stub.rewards.get('z2')?.is_enabled).toBe(true);
    const recovered = moduleById(zomboid.id);
    expect(recovered.status).toBe('active');
    expect(recovered.statusDetail).toBe('');
    expect(getCategoryModulesResponse().lastSignalSource).toBe('manual_reconcile');
  });

  test('a reward update Twitch rejects degrades the module', async () => {
    seedRewardGroup('grp-zomboid', 'Zomboid', [
      reward('z1', false),
      reward('z2', false, { rejectUpdate: true }),
    ]);
    const zomboid = createCategoryModule({
      name: 'Zomboid', enabled: true,
      games: [{ id: GAME_ZOMBOID, name: 'Project Zomboid' }], rewardGroupIds: ['grp-zomboid'],
    });

    await onCategorySignal(state, 'channel_update', GAME_ZOMBOID);

    expect(stub.rewards.get('z1')?.is_enabled).toBe(true);
    expect(stub.rewards.get('z2')?.is_enabled).toBe(false);
    const degraded = moduleById(zomboid.id);
    expect(degraded.status).toBe('degraded');
    expect(degraded.statusDetail).not.toBe('');
  });

  test('a failed category lookup changes no remote reward state', async () => {
    seedRewardGroup('grp-zomboid', 'Zomboid', [reward('z1', false)]);
    seedRewardGroup('grp-elite', 'Elite', [reward('e1', false)]);
    const zomboid = createCategoryModule({
      name: 'Zomboid', enabled: true,
      games: [{ id: GAME_ZOMBOID, name: 'Project Zomboid' }], rewardGroupIds: ['grp-zomboid'],
    });
    createCategoryModule({
      name: 'Elite', enabled: true,
      games: [{ id: GAME_ELITE, name: 'Elite: Dangerous' }], rewardGroupIds: ['grp-elite'],
    });

    await onCategorySignal(state, 'channel_update', GAME_ZOMBOID);
    stub.patches = [];

    // Twitch cannot tell us the live category — we must not guess.
    stub.channelStatus = 503;
    await reconcileCategoryModules(state);

    expect(stub.patches).toEqual([]);
    expect(stub.rewards.get('z1')?.is_enabled).toBe(true);
    expect(stub.rewards.get('e1')?.is_enabled).toBe(false);

    const response = getCategoryModulesResponse();
    // Last known state is kept; the module reports degraded so the operator can retry.
    expect(response.activeModuleId).toBe(zomboid.id);
    expect(response.activeGameId).toBe(GAME_ZOMBOID);
    expect(moduleById(zomboid.id).status).toBe('degraded');
    expect(moduleById(zomboid.id).statusDetail).not.toBe('');
  });

  test('rewards that cannot be loaded from Twitch leave remote state untouched', async () => {
    seedRewardGroup('grp-zomboid', 'Zomboid', [reward('z1', false)]);
    const zomboid = createCategoryModule({
      name: 'Zomboid', enabled: true,
      games: [{ id: GAME_ZOMBOID, name: 'Project Zomboid' }], rewardGroupIds: ['grp-zomboid'],
    });

    // No Twitch login at all.
    state.runtimeUserToken = null;

    await onCategorySignal(state, 'channel_update', GAME_ZOMBOID);

    expect(stub.patches).toEqual([]);
    expect(moduleById(zomboid.id).status).toBe('degraded');
    expect(getCategoryModulesResponse().activeModuleId).toBeNull();
  });
});

// --- Reconcile ---------------------------------------------------------------

describe('reconcileCategoryModules', () => {
  test('refetches the live category and activates the matching module', async () => {
    seedRewardGroup('grp-elite', 'Elite', [reward('e1', false)]);
    const elite = createCategoryModule({
      name: 'Elite', enabled: true,
      games: [{ id: GAME_ELITE, name: 'Elite: Dangerous' }], rewardGroupIds: ['grp-elite'],
    });

    stub.liveGameId = GAME_ELITE;
    stub.liveGameName = 'Elite: Dangerous';

    await reconcileCategoryModules(state);

    expect(stub.channelCalls).toBe(1);
    expect(enabledPatches()).toEqual(['e1']);
    const response = getCategoryModulesResponse();
    expect(response.activeModuleId).toBe(elite.id);
    expect(response.activeGameName).toBe('Elite: Dangerous');
    expect(response.lastSignalSource).toBe('manual_reconcile');
    expect(response.lastReconciledAt).not.toBeNull();
    expect(moduleById(elite.id).status).toBe('active');
  });

  test('a channel with no category set leaves no module active', async () => {
    seedRewardGroup('grp-elite', 'Elite', [reward('e1', true)]);
    createCategoryModule({
      name: 'Elite', enabled: true,
      games: [{ id: GAME_ELITE, name: 'Elite: Dangerous' }], rewardGroupIds: ['grp-elite'],
    });

    stub.liveGameId = null;
    stub.liveGameName = null;

    await reconcileCategoryModules(state);

    expect(disabledPatches()).toEqual(['e1']);
    expect(getCategoryModulesResponse().activeModuleId).toBeNull();
    expect(getCategoryModulesResponse().activeGameId).toBeNull();
  });
});
