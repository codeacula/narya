import type express from 'express';
import type {
  CategoryModule,
  CategoryModuleInput,
  CategoryModulesResponse,
  CategoryModuleStatus,
  CategorySignalSource,
  RewardStreamCategory,
  StreamCategoryRewardGroup,
} from '../shared/api';
import { db } from './db';
import { HttpRouteError, readResponseError, sendRouteError } from './http';
import { broadcast } from './realtime';
import type { RuntimeState } from './runtime';
import { parseTwitchGameId } from './streamCategories';
import { getTwitchActionCredentials } from './twitch/api';
import {
  fetchRewards,
  REWARD_SCOPE,
  setRewardGroupEnabled,
  toggleGroupRewards,
  type TwitchRewardCredentials,
} from './viewerRewards';

const CHANNELS_URL = 'https://api.twitch.tv/helix/channels';

type ModuleRow = {
  id: string;
  name: string;
  enabled: number;
  status: CategoryModuleStatus;
  statusDetail: string;
  createdAt: string;
  updatedAt: string;
};

const MODULE_COLUMNS = `
  id, name, enabled, status, status_detail as statusDetail,
  created_at as createdAt, updated_at as updatedAt
`;

const listModuleRows = db.prepare(`select ${MODULE_COLUMNS} from category_modules order by name collate nocase`);
const getModuleRow = db.prepare(`select ${MODULE_COLUMNS} from category_modules where id = ?`);
const insertModuleRow = db.prepare(`
  insert into category_modules (id, name, enabled, status, status_detail, created_at, updated_at)
  values (?, ?, ?, 'idle', '', ?, ?)
`);
const updateModuleRow = db.prepare(`update category_modules set name = ?, enabled = ?, updated_at = ? where id = ?`);
const updateModuleStatusRow = db.prepare(`update category_modules set status = ?, status_detail = ?, updated_at = ? where id = ?`);
const deleteModuleRow = db.prepare(`delete from category_modules where id = ?`);

const listModuleGameRows = db.prepare(`
  select module_id as moduleId, game_id as id, game_name as name
  from category_module_games
  order by game_name collate nocase
`);
const getGameOwnerRow = db.prepare(`select module_id as moduleId, game_name as name from category_module_games where game_id = ?`);
const deleteModuleGamesRow = db.prepare(`delete from category_module_games where module_id = ?`);
const insertModuleGameRow = db.prepare(`
  insert into category_module_games (game_id, module_id, game_name, created_at) values (?, ?, ?, ?)
`);

const listModuleGroupRows = db.prepare(`
  select mg.module_id as moduleId, g.id as id, g.name as name
  from category_module_reward_groups mg
  join viewer_reward_categories g on g.id = mg.group_id
  order by g.name collate nocase
`);
const deleteModuleGroupsRow = db.prepare(`delete from category_module_reward_groups where module_id = ?`);
const insertModuleGroupRow = db.prepare(`
  insert or ignore into category_module_reward_groups (module_id, group_id, created_at) values (?, ?, ?)
`);
const getRewardGroupRow = db.prepare(`select id, name from viewer_reward_categories where id = ?`);
const getSavedCategoryRow = db.prepare(`select game_name as name from stream_categories where game_id = ?`);

// --- Repository --------------------------------------------------------------

function gamesByModule(): Map<string, RewardStreamCategory[]> {
  const map = new Map<string, RewardStreamCategory[]>();
  for (const row of listModuleGameRows.all() as Array<{ moduleId: string; id: string; name: string }>) {
    const list = map.get(row.moduleId) ?? [];
    list.push({ id: row.id, name: row.name });
    map.set(row.moduleId, list);
  }
  return map;
}

function groupsByModule(): Map<string, StreamCategoryRewardGroup[]> {
  const map = new Map<string, StreamCategoryRewardGroup[]>();
  for (const row of listModuleGroupRows.all() as Array<{ moduleId: string; id: string; name: string }>) {
    const list = map.get(row.moduleId) ?? [];
    list.push({ id: row.id, name: row.name });
    map.set(row.moduleId, list);
  }
  return map;
}

function toCategoryModule(
  row: ModuleRow,
  games: Map<string, RewardStreamCategory[]>,
  groups: Map<string, StreamCategoryRewardGroup[]>,
): CategoryModule {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled === 1,
    status: row.status,
    statusDetail: row.statusDetail,
    games: games.get(row.id) ?? [],
    rewardGroups: groups.get(row.id) ?? [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function listCategoryModules(): CategoryModule[] {
  const games = gamesByModule();
  const groups = groupsByModule();
  return (listModuleRows.all() as ModuleRow[]).map(row => toCategoryModule(row, games, groups));
}

export function getCategoryModule(id: string): CategoryModule | null {
  const row = getModuleRow.get(id) as ModuleRow | null;
  return row ? toCategoryModule(row, gamesByModule(), groupsByModule()) : null;
}

function normalizeModuleName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) throw new HttpRouteError(400, 'Module name is required.');
  if (name.length > 60) throw new HttpRouteError(400, 'Module name must be 60 characters or fewer.');
  return name;
}

function normalizeModuleGames(value: unknown): RewardStreamCategory[] {
  if (!Array.isArray(value)) throw new HttpRouteError(400, 'Stream categories must be a list.');
  if (value.length > 20) throw new HttpRouteError(400, 'A module can claim at most 20 stream categories.');
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

function normalizeRewardGroupIds(value: unknown): string[] {
  if (!Array.isArray(value)) throw new HttpRouteError(400, 'Reward groups must be a list.');
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) throw new HttpRouteError(400, 'Invalid reward group.');
    const id = item.trim();
    if (!getRewardGroupRow.get(id)) throw new HttpRouteError(400, 'Reward group does not exist.');
    seen.add(id);
  }
  return [...seen];
}

export function normalizeCategoryModuleInput(body: unknown): CategoryModuleInput {
  const value = body as Partial<CategoryModuleInput>;
  return {
    name: normalizeModuleName(value?.name),
    enabled: value?.enabled !== false,
    games: normalizeModuleGames(value?.games ?? []),
    rewardGroupIds: normalizeRewardGroupIds(value?.rewardGroupIds ?? []),
  };
}

// `category_module_games.game_id` is the primary key, so a game can only ever be
// claimed once. Check first to turn that into a readable 409 instead of a raw
// SQLite constraint error, and keep the SQLite failure as a backstop.
function claimGames(moduleId: string, games: RewardStreamCategory[]) {
  for (const game of games) {
    const owner = getGameOwnerRow.get(game.id) as { moduleId: string } | null;
    if (owner && owner.moduleId !== moduleId) {
      throw new HttpRouteError(409, `"${game.name}" is already claimed by another category module.`);
    }
  }
  deleteModuleGamesRow.run(moduleId);
  const now = new Date().toISOString();
  for (const game of games) insertModuleGameRow.run(game.id, moduleId, game.name, now);
}

function claimGroups(moduleId: string, groupIds: string[]) {
  deleteModuleGroupsRow.run(moduleId);
  const now = new Date().toISOString();
  for (const groupId of groupIds) insertModuleGroupRow.run(moduleId, groupId, now);
}

function asHttpError(error: unknown, name: string): unknown {
  if (error instanceof Error && error.message.includes('UNIQUE constraint failed: category_modules.name')) {
    return new HttpRouteError(409, `A category module named "${name}" already exists.`);
  }
  if (error instanceof Error && error.message.includes('category_module_games')) {
    return new HttpRouteError(409, 'One of those stream categories is already claimed by another category module.');
  }
  return error;
}

const createModuleTxn = db.transaction((id: string, input: CategoryModuleInput) => {
  const now = new Date().toISOString();
  insertModuleRow.run(id, input.name, input.enabled ? 1 : 0, now, now);
  claimGames(id, input.games);
  claimGroups(id, input.rewardGroupIds);
});

const updateModuleTxn = db.transaction((id: string, input: CategoryModuleInput) => {
  updateModuleRow.run(input.name, input.enabled ? 1 : 0, new Date().toISOString(), id);
  claimGames(id, input.games);
  claimGroups(id, input.rewardGroupIds);
});

export function createCategoryModule(input: CategoryModuleInput): CategoryModule {
  const id = crypto.randomUUID();
  try {
    createModuleTxn(id, input);
  } catch (error) {
    throw asHttpError(error, input.name);
  }
  const created = getCategoryModule(id);
  if (!created) throw new HttpRouteError(500, 'Category module could not be created.');
  return created;
}

export function updateCategoryModule(id: string, input: CategoryModuleInput): CategoryModule {
  if (!getModuleRow.get(id)) throw new HttpRouteError(404, 'Category module not found.');
  try {
    updateModuleTxn(id, input);
  } catch (error) {
    throw asHttpError(error, input.name);
  }
  const updated = getCategoryModule(id);
  if (!updated) throw new HttpRouteError(500, 'Category module could not be updated.');
  return updated;
}

export function deleteCategoryModule(id: string): boolean {
  const removed = deleteModuleRow.run(id).changes > 0;
  if (removed && coordinator.activeModuleId === id) {
    coordinator.activeModuleId = null;
  }
  return removed;
}

// --- Coordinator state -------------------------------------------------------

type CoordinatorState = {
  activeModuleId: string | null;
  activeGameId: string | null;
  activeGameName: string | null;
  lastSignalSource: CategorySignalSource | null;
  lastReconciledAt: string | null;
  lookupError: string | null;
};

const coordinator: CoordinatorState = {
  activeModuleId: null,
  activeGameId: null,
  activeGameName: null,
  lastSignalSource: null,
  lastReconciledAt: null,
  lookupError: null,
};

// Every signal takes a ticket the moment it arrives. A transition that finds the
// counter has moved on is stale — its result is discarded, never applied, so a
// slow A can't land after C and leave C's rewards wrong.
let signalGeneration = 0;
let transitionChain: Promise<void> = Promise.resolve();

/** Test-only: drop coordinator state between cases. */
export function resetCategoryModuleCoordinator(): void {
  coordinator.activeModuleId = null;
  coordinator.activeGameId = null;
  coordinator.activeGameName = null;
  coordinator.lastSignalSource = null;
  coordinator.lastReconciledAt = null;
  coordinator.lookupError = null;
  signalGeneration = 0;
  transitionChain = Promise.resolve();
}

export function getCategoryModulesResponse(): CategoryModulesResponse {
  return {
    modules: listCategoryModules(),
    activeModuleId: coordinator.activeModuleId,
    activeGameId: coordinator.activeGameId,
    activeGameName: coordinator.activeGameName,
    lastSignalSource: coordinator.lastSignalSource,
    lastReconciledAt: coordinator.lastReconciledAt,
    lookupError: coordinator.lookupError,
  };
}

/**
 * The module matching the live Twitch category, or null when none matches. The
 * trigger dispatcher gates module-scoped triggers on this: null suppresses them
 * while leaving global triggers armed.
 */
export function getActiveModuleId(): string | null {
  return coordinator.activeModuleId;
}

function broadcastModules(): void {
  broadcast('category-modules:updated', getCategoryModulesResponse());
}

function setModuleStatus(id: string, status: CategoryModuleStatus, detail: string): boolean {
  const row = getModuleRow.get(id) as ModuleRow | null;
  if (!row) return false;
  if (row.status === status && row.statusDetail === detail) return false;
  updateModuleStatusRow.run(status, detail, new Date().toISOString(), id);
  return true;
}

function errorMessage(error: unknown): string {
  if (error instanceof HttpRouteError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

// Serialize transitions: one body at a time, newest wins.
function enqueue(run: (generation: number) => Promise<void>): Promise<void> {
  const generation = ++signalGeneration;
  const task = transitionChain.then(() => run(generation)).catch(error => {
    console.error('Category modules: transition failed:', error);
  });
  transitionChain = task;
  return task;
}

// --- Transition --------------------------------------------------------------

function resolveGameName(gameId: string, explicit?: string | null): string | null {
  const provided = explicit?.trim();
  if (provided) return provided;
  const owned = getGameOwnerRow.get(gameId) as { name: string } | null;
  if (owned?.name) return owned.name;
  const saved = getSavedCategoryRow.get(gameId) as { name: string } | null;
  return saved?.name ?? null;
}

function ownedGroupIdsByModule(): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const row of listModuleGroupRows.all() as Array<{ moduleId: string; id: string }>) {
    const set = map.get(row.moduleId) ?? new Set<string>();
    set.add(row.id);
    map.set(row.moduleId, set);
  }
  return map;
}

/**
 * Persist the outcome of a completed transition: the incoming module becomes active
 * (or degraded when Twitch would not fully comply), every other module goes idle.
 */
function applyOutcome(
  source: CategorySignalSource,
  gameId: string | null,
  gameName: string | null,
  incoming: ModuleRow | null,
  problemDetail: string | null,
  rewardsChanged: boolean,
): void {
  const previousActiveId = coordinator.activeModuleId;
  // A problem belongs to whichever module failed to take effect: the one coming in,
  // or — when nothing is coming in — the one that failed to stand down.
  const degradedId = problemDetail ? (incoming?.id ?? previousActiveId) : null;

  let changed = false;
  for (const row of listModuleRows.all() as ModuleRow[]) {
    if (degradedId && row.id === degradedId) {
      changed = setModuleStatus(row.id, 'degraded', problemDetail ?? '') || changed;
    } else if (incoming && row.id === incoming.id) {
      changed = setModuleStatus(row.id, 'active', '') || changed;
    } else {
      changed = setModuleStatus(row.id, 'idle', '') || changed;
    }
  }

  changed = changed
    || coordinator.activeModuleId !== (incoming?.id ?? null)
    || coordinator.activeGameId !== gameId
    || coordinator.lookupError !== null;

  coordinator.activeModuleId = incoming?.id ?? null;
  coordinator.activeGameId = gameId;
  coordinator.activeGameName = gameName;
  coordinator.lastSignalSource = source;
  coordinator.lastReconciledAt = new Date().toISOString();
  // This signal was authoritative, so whatever the last lookup failure was, it is
  // no longer the current state of the world.
  coordinator.lookupError = null;

  if (rewardsChanged) broadcast('rewards:updated', { at: coordinator.lastReconciledAt });
  if (changed) broadcastModules();
}

/** Twitch could not be read or would not comply: keep the last known state, surface a retry. */
function applyDegraded(source: CategorySignalSource, incoming: ModuleRow | null, detail: string): void {
  const degradedId = incoming?.id ?? coordinator.activeModuleId;
  coordinator.lastSignalSource = source;
  // Surface the failure at channel level too. When no module is active there is
  // nothing per-module to hang it on, and "no module active" from a healthy
  // off-category stream must not look identical to "we could not reach Twitch".
  const changed = coordinator.lookupError !== detail;
  coordinator.lookupError = detail;
  console.error(`Category modules: ${source} failed: ${detail}`);
  if (degradedId) {
    if (setModuleStatus(degradedId, 'degraded', detail) || changed) broadcastModules();
  } else if (changed) {
    broadcastModules();
  }
}

async function runTransition(
  state: RuntimeState,
  source: CategorySignalSource,
  rawGameId: string | null,
  explicitGameName: string | null,
  generation: number,
): Promise<void> {
  if (generation !== signalGeneration) return; // Superseded while queued — discard.

  const gameId = rawGameId?.trim() ? parseTwitchGameId(rawGameId.trim()) : null;
  const owner = gameId ? getGameOwnerRow.get(gameId) as { moduleId: string } | null : null;
  const ownerRow = owner ? getModuleRow.get(owner.moduleId) as ModuleRow | null : null;
  // A disabled module never activates; the category simply matches nothing.
  const incoming = ownerRow && ownerRow.enabled === 1 ? ownerRow : null;
  const gameName = gameId ? resolveGameName(gameId, explicitGameName) : null;

  const ownedByModule = ownedGroupIdsByModule();
  const incomingGroupIds = incoming ? (ownedByModule.get(incoming.id) ?? new Set<string>()) : new Set<string>();
  const allOwnedGroupIds = new Set<string>();
  for (const groupIds of ownedByModule.values()) {
    for (const groupId of groupIds) allOwnedGroupIds.add(groupId);
  }

  // Reconcile against every module-owned group, not just the outgoing module's, so a
  // restart or a stale third module can't leave a group stranded on. A group both the
  // outgoing and incoming module own lands in `toEnable`, and toggleGroupRewards skips
  // rewards already enabled — so a shared group is never disabled-then-re-enabled.
  const toEnable = [...incomingGroupIds];
  const toDisable = [...allOwnedGroupIds].filter(groupId => !incomingGroupIds.has(groupId));

  if (toEnable.length === 0 && toDisable.length === 0) {
    applyOutcome(source, gameId, gameName, incoming, null, false);
    return;
  }

  let credentials: TwitchRewardCredentials;
  let rewards: Awaited<ReturnType<typeof fetchRewards>>;
  try {
    credentials = await getTwitchActionCredentials(state, REWARD_SCOPE);
    rewards = await fetchRewards(credentials);
  } catch (error) {
    // Remote state is unreadable, so it must not be written. Keep what we knew.
    applyDegraded(source, incoming, `Could not load rewards from Twitch: ${errorMessage(error)}`);
    return;
  }

  if (generation !== signalGeneration) return; // A newer signal landed mid-fetch — discard.

  let updatedCount = 0;
  let failedCount = 0;
  let readOnlyCount = 0;
  const failedGroups: string[] = [];

  for (const [groupId, enabled] of [
    ...toDisable.map(id => [id, false] as const),
    ...toEnable.map(id => [id, true] as const),
  ]) {
    try {
      const result = await toggleGroupRewards(credentials, rewards, groupId, enabled);
      updatedCount += result.updatedCount;
      failedCount += result.failedCount;
      readOnlyCount += result.skippedReadOnlyCount;
      if (result.failedCount > 0 || result.skippedReadOnlyCount > 0) {
        const group = getRewardGroupRow.get(groupId) as { name: string } | null;
        if (group) failedGroups.push(group.name);
      }
      // The flag records intent; drift from it is what `degraded` reports.
      setRewardGroupEnabled(groupId, enabled);
    } catch (error) {
      failedCount += 1;
      const group = getRewardGroupRow.get(groupId) as { name: string } | null;
      failedGroups.push(group?.name ?? groupId);
      console.error(`Category modules: group "${group?.name ?? groupId}" failed to toggle:`, error);
    }
  }

  if (generation !== signalGeneration) return; // Superseded mid-toggle; the newer transition re-reconciles.

  const problems: string[] = [];
  if (failedCount > 0) problems.push(`${failedCount} reward${failedCount === 1 ? '' : 's'} rejected by Twitch`);
  if (readOnlyCount > 0) problems.push(`${readOnlyCount} read-only reward${readOnlyCount === 1 ? '' : 's'} this app cannot edit`);
  const detail = problems.length > 0
    ? `${problems.join(' and ')} in ${failedGroups.join(', ')}. Retry to re-apply.`
    : null;

  applyOutcome(source, gameId, gameName, incoming, detail, updatedCount > 0);
}

// --- Public signal API -------------------------------------------------------

/**
 * Feed the coordinator a category change. `gameId` null means the channel authoritatively
 * has no category, or none of the modules claim it: no module is active, module-scoped
 * triggers are suppressed, global triggers stay armed.
 *
 * A lookup that *failed* is not a null category — call `onCategoryLookupFailed` for that,
 * so remote reward state is never rewritten from a guess.
 *
 * `gameName` is optional: callers that already know the name (an EventSub `channel.update`
 * payload, a live channel fetch) can pass it; otherwise it is resolved locally.
 */
export function onCategorySignal(
  state: RuntimeState,
  source: CategorySignalSource,
  gameId: string | null,
  gameName: string | null = null,
): Promise<void> {
  return enqueue(generation => runTransition(state, source, gameId, gameName, generation));
}

/** The authoritative category could not be established. Change nothing remotely; expose a retry. */
export function onCategoryLookupFailed(source: CategorySignalSource, reason: string): Promise<void> {
  return enqueue(async generation => {
    if (generation !== signalGeneration) return;
    applyDegraded(source, null, reason);
  });
}

async function fetchLiveStreamCategory(
  credentials: TwitchRewardCredentials,
): Promise<{ gameId: string | null; gameName: string | null }> {
  const params = new URLSearchParams({ broadcaster_id: credentials.broadcasterId });
  const response = await fetch(`${CHANNELS_URL}?${params.toString()}`, {
    headers: { 'Client-Id': credentials.clientId, Authorization: credentials.authorization },
  });
  if (!response.ok) {
    const message = await readResponseError(response, 'Twitch channel lookup failed.');
    throw new HttpRouteError(response.status === 401 || response.status === 403 ? response.status : 502, message);
  }
  const data = await response.json() as { data?: Array<{ game_id?: string; game_name?: string }> };
  const channel = data.data?.[0];
  if (!channel) throw new HttpRouteError(502, 'Twitch did not return the channel.');

  // An empty game_id is authoritative: the channel has no category set.
  const gameId = parseTwitchGameId(channel.game_id ?? '');
  return { gameId, gameName: gameId ? (channel.game_name?.trim() || null) : null };
}

/** Operator-driven refresh/retry: re-read the live category from Twitch, then re-run the coordinator. */
export async function reconcileCategoryModules(state: RuntimeState): Promise<void> {
  let live: { gameId: string | null; gameName: string | null };
  try {
    const credentials = await getTwitchActionCredentials(state, REWARD_SCOPE);
    live = await fetchLiveStreamCategory(credentials);
  } catch (error) {
    await onCategoryLookupFailed('manual_reconcile', `Could not read the live Twitch category: ${errorMessage(error)}`);
    return;
  }
  await onCategorySignal(state, 'manual_reconcile', live.gameId, live.gameName);
}

// --- Routes ------------------------------------------------------------------

export function registerCategoryModuleRoutes(app: express.Express, state: RuntimeState) {
  app.get('/api/category-modules', (_request, response) => {
    response.json(getCategoryModulesResponse());
  });

  // Registered before /:id so the literal paths win.
  app.get('/api/category-modules/status', (_request, response) => {
    response.json(getCategoryModulesResponse());
  });

  app.post('/api/category-modules/reconcile', async (_request, response) => {
    try {
      await reconcileCategoryModules(state);
      response.json(getCategoryModulesResponse());
    } catch (error) {
      sendRouteError(response, error);
    }
  });

  app.post('/api/category-modules', (request, response) => {
    try {
      const input = normalizeCategoryModuleInput(request.body);
      const created = createCategoryModule(input);
      broadcastModules();
      response.status(201).json(created);
    } catch (error) {
      sendRouteError(response, error);
    }
  });

  app.get('/api/category-modules/:id', (request, response) => {
    try {
      const module = getCategoryModule(request.params.id);
      if (!module) throw new HttpRouteError(404, 'Category module not found.');
      response.json(module);
    } catch (error) {
      sendRouteError(response, error);
    }
  });

  app.put('/api/category-modules/:id', (request, response) => {
    try {
      const input = normalizeCategoryModuleInput(request.body);
      const updated = updateCategoryModule(request.params.id, input);
      broadcastModules();
      response.json(updated);
    } catch (error) {
      sendRouteError(response, error);
    }
  });

  app.delete('/api/category-modules/:id', (request, response) => {
    try {
      if (!deleteCategoryModule(request.params.id)) throw new HttpRouteError(404, 'Category module not found.');
      broadcastModules();
      response.status(204).send();
    } catch (error) {
      sendRouteError(response, error);
    }
  });
}
