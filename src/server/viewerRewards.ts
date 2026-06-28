import type express from 'express';
import type {
  ViewerReward,
  ViewerRewardCategory,
  ViewerRewardCategoryToggleResult,
  ViewerRewardsResponse,
  ViewerRewardUpsert,
} from '../shared/api';
import { db } from './db';
import { HttpRouteError, readResponseError, sendRouteError } from './http';
import type { RuntimeState } from './runtime';
import { getTwitchActionCredentials } from './twitch/api';

const REWARD_SCOPE = ['channel:manage:redemptions'] as const;
const REWARDS_URL = 'https://api.twitch.tv/helix/channel_points/custom_rewards';

type TwitchReward = {
  id: string;
  title: string;
  prompt: string;
  cost: number;
  is_enabled: boolean;
  is_paused: boolean;
  is_in_stock: boolean;
  background_color: string;
  image: { url_1x?: string } | null;
  default_image: { url_1x?: string };
};

type CategoryRow = {
  id: string;
  name: string;
  enabled: number;
};

const listCategories = db.prepare(`
  select id, name, enabled
  from viewer_reward_categories
  order by name collate nocase
`);
const getCategory = db.prepare(`
  select id, name, enabled
  from viewer_reward_categories
  where id = ?
`);
const insertCategory = db.prepare(`
  insert into viewer_reward_categories (id, name, enabled, created_at, updated_at)
  values (?, ?, 1, ?, ?)
`);
const updateCategory = db.prepare(`
  update viewer_reward_categories
  set name = ?, enabled = ?, updated_at = ?
  where id = ?
`);
const deleteCategoryMembers = db.prepare(`delete from viewer_reward_category_members where category_id = ?`);
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

function twitchHeaders(credentials: Awaited<ReturnType<typeof getTwitchActionCredentials>>) {
  return {
    'Client-Id': credentials.clientId,
    Authorization: credentials.authorization,
    'Content-Type': 'application/json',
  };
}

async function fetchTwitchRewardList(
  credentials: Awaited<ReturnType<typeof getTwitchActionCredentials>>,
  onlyManageable: boolean,
): Promise<TwitchReward[]> {
  const params = new URLSearchParams({
    broadcaster_id: credentials.broadcasterId,
    only_manageable_rewards: String(onlyManageable),
  });
  const response = await fetch(`${REWARDS_URL}?${params.toString()}`, {
    headers: twitchHeaders(credentials),
  });
  if (!response.ok) {
    const message = await readResponseError(response, 'Twitch rewards are unavailable.');
    throw new HttpRouteError(response.status === 401 || response.status === 403 ? response.status : 502, message);
  }
  const data = await response.json() as { data?: TwitchReward[] };
  return data.data ?? [];
}

async function fetchRewards(
  credentials: Awaited<ReturnType<typeof getTwitchActionCredentials>>,
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
  }));
}

function getCategories(rewards: ViewerReward[]): ViewerRewardCategory[] {
  const rewardCounts = new Map<string, number>();
  for (const reward of rewards) {
    if (reward.categoryId) rewardCounts.set(reward.categoryId, (rewardCounts.get(reward.categoryId) ?? 0) + 1);
  }
  return (listCategories.all() as CategoryRow[]).map(category => ({
    id: category.id,
    name: category.name,
    enabled: category.enabled === 1,
    rewardCount: rewardCounts.get(category.id) ?? 0,
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

function normalizeReward(body: unknown): ViewerRewardUpsert {
  const value = body as Partial<ViewerRewardUpsert>;
  const title = typeof value.title === 'string' ? value.title.trim() : '';
  const prompt = typeof value.prompt === 'string' ? value.prompt.trim() : '';
  const cost = typeof value.cost === 'number' ? Math.round(value.cost) : Number(value.cost);
  if (!title || title.length > 45) throw new HttpRouteError(400, 'Reward title must be between 1 and 45 characters.');
  if (prompt.length > 200) throw new HttpRouteError(400, 'Reward prompt must be 200 characters or fewer.');
  if (!Number.isSafeInteger(cost) || cost < 1) throw new HttpRouteError(400, 'Reward cost must be a positive whole number.');
  return {
    title,
    prompt,
    cost,
    isEnabled: value.isEnabled !== false,
    categoryId: normalizeCategoryId(value.categoryId),
  };
}

async function sendTwitchRewardUpdate(
  credentials: Awaited<ReturnType<typeof getTwitchActionCredentials>>,
  rewardId: string,
  fields: Record<string, unknown>,
) {
  const params = new URLSearchParams({ broadcaster_id: credentials.broadcasterId, id: rewardId });
  const response = await fetch(`${REWARDS_URL}?${params.toString()}`, {
    method: 'PATCH',
    headers: twitchHeaders(credentials),
    body: JSON.stringify(fields),
  });
  if (!response.ok) {
    const message = await readResponseError(response, 'Twitch reward update failed.');
    throw new HttpRouteError(response.status === 400 || response.status === 401 || response.status === 403 || response.status === 404 ? response.status : 502, message);
  }
}

function saveRewardCategory(rewardId: string, categoryId: string | null) {
  if (categoryId) setRewardCategory.run(rewardId, categoryId, new Date().toISOString());
  else clearRewardCategory.run(rewardId);
}

export function registerViewerRewardRoutes(app: express.Express, state: RuntimeState) {
  app.get('/api/twitch/rewards', async (_request, response) => {
    try {
      response.json(await getRewardsResponse(state));
    } catch (error) {
      sendRouteError(response, error);
    }
  });

  app.post('/api/twitch/reward-categories', async (request, response) => {
    try {
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
      response.status(201).json({ id, name, enabled: true, rewardCount: 0 } satisfies ViewerRewardCategory);
    } catch (error) {
      sendRouteError(response, error);
    }
  });

  app.patch('/api/twitch/reward-categories/:id', async (request, response) => {
    try {
      const current = getCategory.get(request.params.id) as CategoryRow | null;
      if (!current) throw new HttpRouteError(404, 'Reward category not found.');
      const name = request.body?.name === undefined ? current.name : normalizeCategoryName(request.body.name);
      const enabled = typeof request.body?.enabled === 'boolean' ? request.body.enabled : current.enabled === 1;

      let updatedCount = 0;
      let skippedReadOnlyCount = 0;
      if (enabled !== (current.enabled === 1)) {
        const credentials = await getTwitchActionCredentials(state, REWARD_SCOPE);
        const rewards = await fetchRewards(credentials);
        const categoryRewardIds = new Set(
          (listCategoryRewardIds.all(current.id) as Array<{ rewardId: string }>).map(item => item.rewardId),
        );
        const categoryRewards = rewards.filter(reward => categoryRewardIds.has(reward.id));
        const writableRewards = categoryRewards.filter(reward => reward.canManage && reward.isEnabled !== enabled);
        skippedReadOnlyCount = categoryRewards.filter(reward => !reward.canManage && reward.isEnabled !== enabled).length;
        const results = await Promise.allSettled(
          writableRewards.map(reward => sendTwitchRewardUpdate(credentials, reward.id, { is_enabled: enabled })),
        );
        const failed = results.filter(result => result.status === 'rejected');
        updatedCount = results.length - failed.length;
        if (failed.length > 0) {
          throw new HttpRouteError(502, `${failed.length} reward${failed.length === 1 ? '' : 's'} could not be updated on Twitch.`);
        }
      }

      try {
        updateCategory.run(name, enabled ? 1 : 0, new Date().toISOString(), current.id);
      } catch (error) {
        if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
          throw new HttpRouteError(409, `A category named "${name}" already exists.`);
        }
        throw error;
      }

      const payload = await getRewardsResponse(state) as ViewerRewardCategoryToggleResult;
      payload.updatedCount = updatedCount;
      payload.skippedReadOnlyCount = skippedReadOnlyCount;
      response.json(payload);
    } catch (error) {
      sendRouteError(response, error);
    }
  });

  app.delete('/api/twitch/reward-categories/:id', (request, response) => {
    try {
      if (!getCategory.get(request.params.id)) throw new HttpRouteError(404, 'Reward category not found.');
      db.transaction((id: string) => {
        deleteCategoryMembers.run(id);
        deleteCategory.run(id);
      })(request.params.id);
      response.status(204).send();
    } catch (error) {
      sendRouteError(response, error);
    }
  });

  app.post('/api/twitch/rewards', async (request, response) => {
    try {
      const reward = normalizeReward(request.body);
      const category = reward.categoryId ? getCategory.get(reward.categoryId) as CategoryRow : null;
      const credentials = await getTwitchActionCredentials(state, REWARD_SCOPE);
      const params = new URLSearchParams({ broadcaster_id: credentials.broadcasterId });
      const twitchResponse = await fetch(`${REWARDS_URL}?${params.toString()}`, {
        method: 'POST',
        headers: twitchHeaders(credentials),
        body: JSON.stringify({
          title: reward.title,
          prompt: reward.prompt,
          cost: reward.cost,
          is_enabled: category?.enabled === 0 ? false : reward.isEnabled,
        }),
      });
      if (!twitchResponse.ok) {
        const message = await readResponseError(twitchResponse, 'Twitch reward creation failed.');
        throw new HttpRouteError(twitchResponse.status === 400 || twitchResponse.status === 401 || twitchResponse.status === 403 ? twitchResponse.status : 502, message);
      }
      const data = await twitchResponse.json() as { data?: TwitchReward[] };
      const created = data.data?.[0];
      if (!created) throw new HttpRouteError(502, 'Twitch did not return the created reward.');
      saveRewardCategory(created.id, reward.categoryId);
      response.status(201).json(await getRewardsResponse(state));
    } catch (error) {
      sendRouteError(response, error);
    }
  });

  app.patch('/api/twitch/rewards/:id', async (request, response) => {
    try {
      const credentials = await getTwitchActionCredentials(state, REWARD_SCOPE);
      const currentRewards = await fetchRewards(credentials);
      const current = currentRewards.find(reward => reward.id === request.params.id);
      if (!current) throw new HttpRouteError(404, 'Reward not found.');

      const categoryId = request.body?.categoryId === undefined
        ? current.categoryId
        : normalizeCategoryId(request.body.categoryId);
      const hasTwitchFields = ['title', 'prompt', 'cost', 'isEnabled'].some(key => request.body?.[key] !== undefined);
      if (hasTwitchFields) {
        if (!current.canManage) throw new HttpRouteError(403, 'Twitch only allows this app to edit rewards that it created.');
        const reward = normalizeReward({
          title: request.body.title ?? current.title,
          prompt: request.body.prompt ?? current.prompt,
          cost: request.body.cost ?? current.cost,
          isEnabled: request.body.isEnabled ?? current.isEnabled,
          categoryId,
        });
        const category = categoryId ? getCategory.get(categoryId) as CategoryRow : null;
        await sendTwitchRewardUpdate(credentials, current.id, {
          title: reward.title,
          prompt: reward.prompt,
          cost: reward.cost,
          is_enabled: category?.enabled === 0 ? false : reward.isEnabled,
        });
      } else if (categoryId !== current.categoryId && categoryId && current.canManage) {
        const category = getCategory.get(categoryId) as CategoryRow;
        const categoryEnabled = category.enabled === 1;
        if (current.isEnabled !== categoryEnabled) {
          await sendTwitchRewardUpdate(credentials, current.id, { is_enabled: categoryEnabled });
        }
      }
      saveRewardCategory(current.id, categoryId);
      response.json(await getRewardsResponse(state));
    } catch (error) {
      sendRouteError(response, error);
    }
  });

  app.delete('/api/twitch/rewards/:id', async (request, response) => {
    try {
      const credentials = await getTwitchActionCredentials(state, REWARD_SCOPE);
      const params = new URLSearchParams({ broadcaster_id: credentials.broadcasterId, id: request.params.id });
      const twitchResponse = await fetch(`${REWARDS_URL}?${params.toString()}`, {
        method: 'DELETE',
        headers: twitchHeaders(credentials),
      });
      if (!twitchResponse.ok) {
        const message = await readResponseError(twitchResponse, 'Twitch reward deletion failed.');
        throw new HttpRouteError(twitchResponse.status === 400 || twitchResponse.status === 401 || twitchResponse.status === 403 || twitchResponse.status === 404 ? twitchResponse.status : 502, message);
      }
      clearRewardCategory.run(request.params.id);
      response.status(204).send();
    } catch (error) {
      sendRouteError(response, error);
    }
  });
}
