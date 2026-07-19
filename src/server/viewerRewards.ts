import type express from 'express';
import type {
  RewardStreamCategory,
  ViewerReward,
  ViewerRewardCategory,
  ViewerRewardCategoryToggleResult,
  ViewerRewardsResponse,
  ViewerRewardUpsert,
} from '../shared/api';
import { db } from './db';
import { handle, HttpRouteError, readResponseError } from './http';
import { broadcast } from './realtime';

import type { RuntimeState } from './runtime';
import { parseTwitchGameId } from './streamCategories';
import { getTwitchActionCredentials, twitchFetch } from './twitch/api';

export const REWARD_SCOPE = ['channel:manage:redemptions'] as const;
const REWARDS_URL = 'https://api.twitch.tv/helix/channel_points/custom_rewards';

export type TwitchRewardCredentials = Awaited<ReturnType<typeof getTwitchActionCredentials>>;

type TwitchReward = {
  id: string;
  title: string;
  prompt: string;
  cost: number;
  is_enabled: boolean;
  is_paused: boolean;
  is_in_stock: boolean;
  is_user_input_required: boolean;
  background_color: string;
  image: { url_1x?: string } | null;
  default_image: { url_1x?: string };
  should_redemptions_skip_request_queue: boolean;
  global_cooldown_setting: { is_enabled: boolean; global_cooldown_seconds: number };
  max_per_stream_setting: { is_enabled: boolean; max_per_stream: number };
  max_per_user_per_stream_setting: { is_enabled: boolean; max_per_user_per_stream: number };
};

type CategoryRow = {
  id: string;
  name: string;
  enabled: number;
  default_background_color: string | null;
};

const listCategories = db.prepare(`
  select id, name, enabled, default_background_color
  from viewer_reward_categories
  order by name collate nocase
`);
const getCategory = db.prepare(`
  select id, name, enabled, default_background_color
  from viewer_reward_categories
  where id = ?
`);
const insertCategory = db.prepare(`
  insert into viewer_reward_categories (id, name, enabled, created_at, updated_at)
  values (?, ?, 1, ?, ?)
`);
const updateCategory = db.prepare(`
  update viewer_reward_categories
  set name = ?, enabled = ?, default_background_color = ?, updated_at = ?
  where id = ?
`);
const deleteCategory = db.prepare(`delete from viewer_reward_categories where id = ?`);
const listCategoryMembers = db.prepare(`
  select reward_id as rewardId, category_id as categoryId
  from viewer_reward_category_members
`);
const listCategoryRewardIds = db.prepare(`
  select reward_id as rewardId
  from viewer_reward_category_members
  where category_id = ?
`);
const setRewardCategory = db.prepare(`
  insert into viewer_reward_category_members (reward_id, category_id, updated_at)
  values (?, ?, ?)
  on conflict(reward_id) do update set
    category_id = excluded.category_id,
    updated_at = excluded.updated_at
`);
const clearRewardCategory = db.prepare(`delete from viewer_reward_category_members where reward_id = ?`);
const listCategoryGames = db.prepare(`
  select category_id as categoryId, game_id as id, game_name as name
  from viewer_reward_category_games
`);
const deleteCategoryGames = db.prepare(`delete from viewer_reward_category_games where category_id = ?`);
const insertCategoryGame = db.prepare(`
  insert or ignore into viewer_reward_category_games (category_id, game_id, game_name, created_at)
  values (?, ?, ?, ?)
`);
const replaceCategoryGames = db.transaction((categoryId: string, games: RewardStreamCategory[]) => {
  deleteCategoryGames.run(categoryId);
  const now = new Date().toISOString();
  for (const game of games) insertCategoryGame.run(categoryId, game.id, game.name, now);
});

const JSON_CONTENT_TYPE = { 'Content-Type': 'application/json' };

async function fetchTwitchRewardList(
  credentials: Awaited<ReturnType<typeof getTwitchActionCredentials>>,
  onlyManageable: boolean,
): Promise<TwitchReward[]> {
  const params = new URLSearchParams({
    broadcaster_id: credentials.broadcasterId,
    only_manageable_rewards: String(onlyManageable),
  });
  const response = await twitchFetch(`${REWARDS_URL}?${params.toString()}`, {
    credentials,
    headers: JSON_CONTENT_TYPE,
    errorMessage: 'Twitch rewards are unavailable.',
  });
  const data = await response.json() as { data?: TwitchReward[] };
  return data.data ?? [];
}

export async function fetchRewards(
  credentials: TwitchRewardCredentials,
): Promise<ViewerReward[]> {
  const [allRewards, manageableRewards] = await Promise.all([
    fetchTwitchRewardList(credentials, false),
    fetchTwitchRewardList(credentials, true),
  ]);
  const manageableIds = new Set(manageableRewards.map(reward => reward.id));
  const categoryIds = new Map(
    (listCategoryMembers.all() as Array<{ rewardId: string; categoryId: string }>)
      .map(member => [member.rewardId, member.categoryId]),
  );

  return allRewards.map(reward => ({
    id: reward.id,
    title: reward.title,
    prompt: reward.prompt,
    cost: reward.cost,
    isEnabled: reward.is_enabled,
    isPaused: reward.is_paused,
    isInStock: reward.is_in_stock,
    canManage: manageableIds.has(reward.id),
    imageUrl: reward.image?.url_1x ?? reward.default_image?.url_1x ?? null,
    backgroundColor: reward.background_color,
    categoryId: categoryIds.get(reward.id) ?? null,
    isUserInputRequired: reward.is_user_input_required ?? false,
    skipQueue: reward.should_redemptions_skip_request_queue ?? false,
    globalCooldown: {
      enabled: reward.global_cooldown_setting?.is_enabled ?? false,
      seconds: reward.global_cooldown_setting?.global_cooldown_seconds ?? 0,
    },
    maxPerStream: {
      enabled: reward.max_per_stream_setting?.is_enabled ?? false,
      max: reward.max_per_stream_setting?.max_per_stream ?? 1,
    },
    maxPerUserPerStream: {
      enabled: reward.max_per_user_per_stream_setting?.is_enabled ?? false,
      max: reward.max_per_user_per_stream_setting?.max_per_user_per_stream ?? 1,
    },
  }));
}

function getCategories(rewards: ViewerReward[]): ViewerRewardCategory[] {
  const rewardCounts = new Map<string, number>();
  for (const reward of rewards) {
    if (reward.categoryId) rewardCounts.set(reward.categoryId, (rewardCounts.get(reward.categoryId) ?? 0) + 1);
  }
  const gamesByCategory = new Map<string, RewardStreamCategory[]>();
  for (const row of listCategoryGames.all() as Array<{ categoryId: string; id: string; name: string }>) {
    const list = gamesByCategory.get(row.categoryId) ?? [];
    list.push({ id: row.id, name: row.name });
    gamesByCategory.set(row.categoryId, list);
  }
  return (listCategories.all() as CategoryRow[]).map(category => ({
    id: category.id,
    name: category.name,
    enabled: category.enabled === 1,
    rewardCount: rewardCounts.get(category.id) ?? 0,
    defaultBackgroundColor: category.default_background_color ?? null,
    games: gamesByCategory.get(category.id) ?? [],
  }));
}

async function getRewardsResponse(state: RuntimeState): Promise<ViewerRewardsResponse> {
  const credentials = await getTwitchActionCredentials(state, REWARD_SCOPE);
  const rewards = await fetchRewards(credentials);
  return { categories: getCategories(rewards), rewards };
}

function normalizeCategoryName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) throw new HttpRouteError(400, 'Category name is required.');
  if (name.length > 60) throw new HttpRouteError(400, 'Category name must be 60 characters or fewer.');
  return name;
}

function normalizeCategoryId(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw new HttpRouteError(400, 'Invalid reward category.');
  if (!getCategory.get(value)) throw new HttpRouteError(400, 'Reward category does not exist.');
  return value;
}

function normalizeHexColor(value: unknown, fallback = '#9147FF'): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim().toUpperCase();
  return /^#[0-9A-F]{6}$/.test(trimmed) ? trimmed : fallback;
}

function normalizeReward(body: unknown): ViewerRewardUpsert {
  const value = body as Partial<ViewerRewardUpsert>;
  const title = typeof value.title === 'string' ? value.title.trim() : '';
  const prompt = typeof value.prompt === 'string' ? value.prompt.trim() : '';
  const cost = typeof value.cost === 'number' ? Math.round(value.cost) : Number(value.cost);
  if (!title || title.length > 45) throw new HttpRouteError(400, 'Reward title must be between 1 and 45 characters.');
  if (prompt.length > 200) throw new HttpRouteError(400, 'Reward description must be 200 characters or fewer.');
  if (!Number.isSafeInteger(cost) || cost < 1) throw new HttpRouteError(400, 'Reward cost must be a positive whole number.');

  const mps = value.maxPerStream;
  const mpuPS = value.maxPerUserPerStream;
  const maxPerStreamEnabled = typeof mps === 'object' && mps !== null ? Boolean(mps.enabled) : false;
  const maxPerStreamVal = typeof mps === 'object' && mps !== null ? Math.max(1, Math.round(Number(mps.max) || 1)) : 1;
  const maxPerUserEnabled = typeof mpuPS === 'object' && mpuPS !== null ? Boolean(mpuPS.enabled) : false;
  const maxPerUserVal = typeof mpuPS === 'object' && mpuPS !== null ? Math.max(1, Math.round(Number(mpuPS.max) || 1)) : 1;

  const cd = value.globalCooldown;
  const cooldownEnabled = typeof cd === 'object' && cd !== null ? Boolean(cd.enabled) : false;
  // Twitch requires 1s–604800s (7 days); keep a valid value even while disabled so the payload never 400s.
  const cooldownSeconds = typeof cd === 'object' && cd !== null
    ? Math.min(604_800, Math.max(1, Math.round(Number(cd.seconds) || 60)))
    : 60;

  return {
    title,
    prompt,
    cost,
    isEnabled: value.isEnabled !== false,
    isPaused: value.isPaused === true,
    categoryId: normalizeCategoryId(value.categoryId),
    isUserInputRequired: value.isUserInputRequired === true,
    skipQueue: value.skipQueue === true,
    backgroundColor: normalizeHexColor(value.backgroundColor),
    globalCooldown: { enabled: cooldownEnabled, seconds: cooldownSeconds },
    maxPerStream: { enabled: maxPerStreamEnabled, max: maxPerStreamVal },
    maxPerUserPerStream: { enabled: maxPerUserEnabled, max: maxPerUserVal },
  };
}

// Twitch's create/update endpoints take FLAT fields (is_global_cooldown_enabled, global_cooldown_seconds,
// is_max_per_stream_enabled, …) even though the GET response nests them under *_setting objects. Sending the
// nested shape here is silently ignored, which is why limits set through this app never applied before.
function twitchRewardBody(reward: ViewerRewardUpsert, isEnabled: boolean, includePaused: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    title: reward.title,
    prompt: reward.prompt,
    cost: reward.cost,
    is_enabled: isEnabled,
    is_user_input_required: reward.isUserInputRequired,
    background_color: reward.backgroundColor,
    should_redemptions_skip_request_queue: reward.skipQueue,
    is_global_cooldown_enabled: reward.globalCooldown.enabled,
    global_cooldown_seconds: reward.globalCooldown.seconds,
    is_max_per_stream_enabled: reward.maxPerStream.enabled,
    max_per_stream: reward.maxPerStream.max,
    is_max_per_user_per_stream_enabled: reward.maxPerUserPerStream.enabled,
    max_per_user_per_stream: reward.maxPerUserPerStream.max,
  };
  // is_paused is only accepted on update, not create.
  if (includePaused) body.is_paused = reward.isPaused;
  return body;
}

async function sendTwitchRewardUpdate(
  credentials: Awaited<ReturnType<typeof getTwitchActionCredentials>>,
  rewardId: string,
  fields: Record<string, unknown>,
) {
  const params = new URLSearchParams({ broadcaster_id: credentials.broadcasterId, id: rewardId });
  await twitchFetch(`${REWARDS_URL}?${params.toString()}`, {
    credentials,
    method: 'PATCH',
    body: fields,
    errorMessage: 'Twitch reward update failed.',
    passthroughStatuses: [400, 401, 403, 404],
  });
}


function saveRewardCategory(rewardId: string, categoryId: string | null) {
  if (categoryId) setRewardCategory.run(rewardId, categoryId, new Date().toISOString());
  else clearRewardCategory.run(rewardId);
}

function normalizeCategoryGames(value: unknown): RewardStreamCategory[] {
  if (!Array.isArray(value)) throw new HttpRouteError(400, 'Stream categories must be a list.');
  if (value.length > 20) throw new HttpRouteError(400, 'A group can map to at most 20 stream categories.');
  const seen = new Set<string>();
  const games: RewardStreamCategory[] = [];
  for (const item of value) {
    const entry = item as { id?: unknown; name?: unknown };
    const id = parseTwitchGameId(entry.id);
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    if (!id || !name) throw new HttpRouteError(400, 'Each stream category needs a valid id and a name.');
    if (seen.has(id)) continue;
    seen.add(id);
    games.push({ id, name: name.slice(0, 160) });
  }
  return games;
}

// Toggle every manageable reward in a group to `enabled` using a pre-fetched reward list.
// Callers that already loaded rewards/credentials avoid an extra Twitch round-trip per group.
// Rewards already in the target state are filtered out, so re-applying a group that is
// already correct issues zero Twitch calls — the category coordinator relies on that.
export async function toggleGroupRewards(
  credentials: TwitchRewardCredentials,
  rewards: ViewerReward[],
  groupId: string,
  enabled: boolean,
): Promise<{ updatedCount: number; skippedReadOnlyCount: number; failedCount: number }> {
  const groupRewardIds = new Set(
    (listCategoryRewardIds.all(groupId) as Array<{ rewardId: string }>).map(item => item.rewardId),
  );
  const groupRewards = rewards.filter(reward => groupRewardIds.has(reward.id));
  const writable = groupRewards.filter(reward => reward.canManage && reward.isEnabled !== enabled);
  const skippedReadOnlyCount = groupRewards.filter(reward => !reward.canManage && reward.isEnabled !== enabled).length;
  const results = await Promise.allSettled(
    writable.map(reward => sendTwitchRewardUpdate(credentials, reward.id, { is_enabled: enabled })),
  );
  const failedCount = results.filter(result => result.status === 'rejected').length;
  return { updatedCount: writable.length - failedCount, skippedReadOnlyCount, failedCount };
}

const setCategoryEnabled = db.prepare(`
  update viewer_reward_categories set enabled = ?, updated_at = ? where id = ?
`);

// The category coordinator owns which groups are on; it writes the group's local
// flag through here so the Viewer Rewards page reflects the switch.
export function setRewardGroupEnabled(groupId: string, enabled: boolean): void {
  setCategoryEnabled.run(enabled ? 1 : 0, new Date().toISOString(), groupId);
}

export function registerViewerRewardRoutes(app: express.Express, state: RuntimeState) {
  app.get('/api/twitch/rewards', handle(async (_request, response) => {
    response.json(await getRewardsResponse(state));
  }));

  app.post('/api/twitch/reward-categories', handle(async (request, response) => {
    const name = normalizeCategoryName(request.body?.name);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    try {
      insertCategory.run(id, name, now, now);
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
        throw new HttpRouteError(409, `A category named "${name}" already exists.`);
      }
      throw error;
    }
    response.status(201).json({ id, name, enabled: true, rewardCount: 0, defaultBackgroundColor: null, games: [] } satisfies ViewerRewardCategory);
  }));

  app.patch('/api/twitch/reward-categories/:id', handle(async (request, response) => {
    const current = getCategory.get(request.params.id) as CategoryRow | null;
    if (!current) throw new HttpRouteError(404, 'Reward category not found.');
    const name = request.body?.name === undefined ? current.name : normalizeCategoryName(request.body.name);
    const enabled = typeof request.body?.enabled === 'boolean' ? request.body.enabled : current.enabled === 1;
    const defaultBackgroundColor = request.body?.defaultBackgroundColor === undefined
      ? current.default_background_color
      : (typeof request.body.defaultBackgroundColor === 'string'
        ? normalizeHexColor(request.body.defaultBackgroundColor, current.default_background_color ?? '#9147FF')
        : null);
    const games = request.body?.games === undefined ? undefined : normalizeCategoryGames(request.body.games);

    let updatedCount = 0;
    let skippedReadOnlyCount = 0;
    if (enabled !== (current.enabled === 1)) {
      const credentials = await getTwitchActionCredentials(state, REWARD_SCOPE);
      const rewards = await fetchRewards(credentials);
      const result = await toggleGroupRewards(credentials, rewards, current.id, enabled);
      updatedCount = result.updatedCount;
      skippedReadOnlyCount = result.skippedReadOnlyCount;
      if (result.failedCount > 0) {
        throw new HttpRouteError(502, `${result.failedCount} reward${result.failedCount === 1 ? '' : 's'} could not be updated on Twitch.`);
      }
    }

    try {
      updateCategory.run(name, enabled ? 1 : 0, defaultBackgroundColor ?? null, new Date().toISOString(), current.id);
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
        throw new HttpRouteError(409, `A category named "${name}" already exists.`);
      }
      throw error;
    }

    if (games !== undefined) replaceCategoryGames(current.id, games);

    const payload = await getRewardsResponse(state) as ViewerRewardCategoryToggleResult;
    payload.updatedCount = updatedCount;
    payload.skippedReadOnlyCount = skippedReadOnlyCount;
    response.json(payload);
  }));

  app.delete('/api/twitch/reward-categories/:id', handle((request, response) => {
    if (!getCategory.get(request.params.id)) throw new HttpRouteError(404, 'Reward category not found.');
    // Members and game mappings both cascade (see db.ts). Deleting members by
    // hand here used to leave the game mappings orphaned, because the cascade
    // the schema declared was never enabled.
    deleteCategory.run(request.params.id);
    response.status(204).send();
  }));

  app.post('/api/twitch/reward-categories/:id/apply-color', handle(async (request, response) => {
    const category = getCategory.get(request.params.id) as CategoryRow | null;
    if (!category) throw new HttpRouteError(404, 'Reward category not found.');
    if (!category.default_background_color) throw new HttpRouteError(400, 'This category has no default color set.');
    const credentials = await getTwitchActionCredentials(state, REWARD_SCOPE);
    const rewards = await fetchRewards(credentials);
    const categoryRewardIds = new Set(
      (listCategoryRewardIds.all(category.id) as Array<{ rewardId: string }>).map(item => item.rewardId),
    );
    const manageable = rewards.filter(r => categoryRewardIds.has(r.id) && r.canManage);
    const results = await Promise.allSettled(
      manageable.map(r => sendTwitchRewardUpdate(credentials, r.id, { background_color: category.default_background_color })),
    );
    const failed = results.filter(r => r.status === 'rejected');
    if (failed.length > 0) {
      throw new HttpRouteError(502, `${failed.length} reward${failed.length === 1 ? '' : 's'} could not be updated on Twitch.`);
    }
    response.json(await getRewardsResponse(state));
  }));

  app.post('/api/twitch/rewards', handle(async (request, response) => {
    const reward = normalizeReward(request.body);
    const category = reward.categoryId ? getCategory.get(reward.categoryId) as CategoryRow : null;
    const credentials = await getTwitchActionCredentials(state, REWARD_SCOPE);
    const params = new URLSearchParams({ broadcaster_id: credentials.broadcasterId });
    const twitchResponse = await twitchFetch(`${REWARDS_URL}?${params.toString()}`, {
      credentials,
      method: 'POST',
      body: twitchRewardBody(reward, category?.enabled === 0 ? false : reward.isEnabled, false),
      errorMessage: 'Twitch reward creation failed.',
      passthroughStatuses: [400, 401, 403],
    });
    const data = await twitchResponse.json() as { data?: TwitchReward[] };
    const created = data.data?.[0];
    if (!created) throw new HttpRouteError(502, 'Twitch did not return the created reward.');
    saveRewardCategory(created.id, reward.categoryId);
    // Twitch mints the reward id, so the binding can only be saved here — the
    // response returns the whole list, not the created reward.
    response.status(201).json(await getRewardsResponse(state));
  }));

  app.patch('/api/twitch/rewards/:id', handle(async (request, response) => {
    const credentials = await getTwitchActionCredentials(state, REWARD_SCOPE);
    const currentRewards = await fetchRewards(credentials);
    const current = currentRewards.find(reward => reward.id === request.params.id);
    if (!current) throw new HttpRouteError(404, 'Reward not found.');

    const categoryId = request.body?.categoryId === undefined
      ? current.categoryId
      : normalizeCategoryId(request.body.categoryId);
    const hasTwitchFields = ['title', 'prompt', 'cost', 'isEnabled', 'isPaused', 'isUserInputRequired', 'skipQueue', 'backgroundColor', 'globalCooldown', 'maxPerStream', 'maxPerUserPerStream'].some(key => request.body?.[key] !== undefined);
    if (hasTwitchFields) {
      if (!current.canManage) throw new HttpRouteError(403, 'Twitch only allows this app to edit rewards that it created.');
      const reward = normalizeReward({
        title: request.body.title ?? current.title,
        prompt: request.body.prompt ?? current.prompt,
        cost: request.body.cost ?? current.cost,
        isEnabled: request.body.isEnabled ?? current.isEnabled,
        isPaused: request.body.isPaused ?? current.isPaused,
        isUserInputRequired: request.body.isUserInputRequired ?? current.isUserInputRequired,
        skipQueue: request.body.skipQueue ?? current.skipQueue,
        backgroundColor: request.body.backgroundColor ?? current.backgroundColor,
        globalCooldown: request.body.globalCooldown ?? current.globalCooldown,
        maxPerStream: request.body.maxPerStream ?? current.maxPerStream,
        maxPerUserPerStream: request.body.maxPerUserPerStream ?? current.maxPerUserPerStream,
        categoryId,
      });
      const category = categoryId ? getCategory.get(categoryId) as CategoryRow : null;
      await sendTwitchRewardUpdate(credentials, current.id, twitchRewardBody(reward, category?.enabled === 0 ? false : reward.isEnabled, true));
    } else if (categoryId !== current.categoryId && categoryId && current.canManage) {
      const category = getCategory.get(categoryId) as CategoryRow;
      const categoryEnabled = category.enabled === 1;
      if (current.isEnabled !== categoryEnabled) {
        await sendTwitchRewardUpdate(credentials, current.id, { is_enabled: categoryEnabled });
      }
    }
    saveRewardCategory(current.id, categoryId);
    response.json(await getRewardsResponse(state));
  }));


  app.delete('/api/twitch/rewards/:id', handle(async (request, response) => {
    const credentials = await getTwitchActionCredentials(state, REWARD_SCOPE);
    const params = new URLSearchParams({ broadcaster_id: credentials.broadcasterId, id: request.params.id });
    await twitchFetch(`${REWARDS_URL}?${params.toString()}`, {
      credentials,
      method: 'DELETE',
      headers: JSON_CONTENT_TYPE,
      errorMessage: 'Twitch reward deletion failed.',
      passthroughStatuses: [400, 401, 403, 404],
    });
    clearRewardCategory.run(request.params.id);
    response.status(204).send();
  }));
}
