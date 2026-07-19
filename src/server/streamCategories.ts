import type express from 'express';
import type { SavedStreamCategory, SavedStreamCategoryInput, StreamCategoryRewardGroup } from '../shared/api';
import { db } from './db';
import { handle, HttpRouteError } from './http';
import { normalizeTags, recordTagHistory, suggestTagHistory } from './tags';

const listStreamCategoriesRow = db.prepare(`
  select game_id as id, game_name as name, box_art_url as boxArtUrl, hidden
  from stream_categories
  order by game_name collate nocase
`);
const upsertStreamCategory = db.prepare(`
  insert into stream_categories (game_id, game_name, box_art_url, hidden, created_at)
  values (?, ?, ?, 0, ?)
  on conflict(game_id) do update set
    game_name = excluded.game_name,
    box_art_url = excluded.box_art_url
`);
const setStreamCategoryHidden = db.prepare(`update stream_categories set hidden = ? where game_id = ?`);

const listCategoryTagsRow = db.prepare(`select game_id as gameId, tag from stream_category_tags order by rowid`);
const deleteCategoryTagsRow = db.prepare(`delete from stream_category_tags where game_id = ?`);
const insertCategoryTagRow = db.prepare(`insert or ignore into stream_category_tags (game_id, tag, created_at) values (?, ?, ?)`);
const deleteStreamCategoryRow = db.prepare(`delete from stream_categories where game_id = ?`);
const listRewardGroupsByGameRow = db.prepare(`
  select g.game_id as gameId, c.id as id, c.name as name
  from viewer_reward_category_games g
  join viewer_reward_categories c on c.id = g.category_id
  order by c.name collate nocase
`);

const replaceCategoryTagsTxn = db.transaction((gameId: string, tags: string[]) => {
  deleteCategoryTagsRow.run(gameId);
  const now = new Date().toISOString();
  for (const tag of tags) insertCategoryTagRow.run(gameId, tag, now);
});

const deleteStreamCategoryTxn = db.transaction((gameId: string): number => {
  deleteCategoryTagsRow.run(gameId);
  return deleteStreamCategoryRow.run(gameId).changes;
});

type StreamCategoryRow = { id: string; name: string; boxArtUrl: string | null; hidden: number };

function tagsByGame(): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const row of listCategoryTagsRow.all() as Array<{ gameId: string; tag: string }>) {
    const list = map.get(row.gameId) ?? [];
    list.push(row.tag);
    map.set(row.gameId, list);
  }
  return map;
}

function rewardGroupsByGame(): Map<string, StreamCategoryRewardGroup[]> {
  const map = new Map<string, StreamCategoryRewardGroup[]>();
  for (const row of listRewardGroupsByGameRow.all() as Array<{ gameId: string; id: string; name: string }>) {
    const list = map.get(row.gameId) ?? [];
    list.push({ id: row.id, name: row.name });
    map.set(row.gameId, list);
  }
  return map;
}

export function listSavedStreamCategories(): SavedStreamCategory[] {
  const tags = tagsByGame();
  const groups = rewardGroupsByGame();
  return (listStreamCategoriesRow.all() as StreamCategoryRow[]).map(row => ({
    id: row.id,
    name: row.name,
    boxArtUrl: row.boxArtUrl ?? null,
    hidden: row.hidden === 1,
    tags: tags.get(row.id) ?? [],
    rewardGroups: groups.get(row.id) ?? [],
  }));
}

export function setSavedStreamCategoryTags(gameId: string, rawTags: unknown): string[] {
  const tags = normalizeTags(rawTags);
  replaceCategoryTagsTxn(gameId, tags);
  recordTagHistory(tags);
  return tags;
}

export function deleteSavedStreamCategory(gameId: string): boolean {
  return deleteStreamCategoryTxn(gameId) > 0;
}

// Twitch game ids are numeric strings; return the trimmed id or null when it isn't a valid one.
export function parseTwitchGameId(value: unknown): string | null {
  const id = typeof value === 'string' ? value.trim() : '';
  return /^\d{1,20}$/.test(id) ? id : null;
}

function normalizeGameId(value: unknown): string {
  const id = parseTwitchGameId(value);
  if (!id) throw new HttpRouteError(400, 'A valid Twitch category id is required.');
  return id;
}

function streamCategoryExists(gameId: string): boolean {
  return (listStreamCategoriesRow.all() as StreamCategoryRow[]).some(row => row.id === gameId);
}

export function registerStreamCategoryRoutes(app: express.Express) {
  app.get('/api/stream-categories', (_request, response) => {
    response.json(listSavedStreamCategories());
  });

  app.post('/api/stream-categories', handle((request, response) => {
    const body = request.body as Partial<SavedStreamCategoryInput>;
    const id = normalizeGameId(body?.id);
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name) throw new HttpRouteError(400, 'Category name is required.');
    const boxArtUrl = typeof body?.boxArtUrl === 'string' && body.boxArtUrl.trim()
      ? body.boxArtUrl.trim()
      : null;
    upsertStreamCategory.run(id, name.slice(0, 160), boxArtUrl, new Date().toISOString());
    response.status(201).json(listSavedStreamCategories());
  }));

  app.patch('/api/stream-categories/:gameId', handle((request, response) => {
    const id = normalizeGameId(request.params.gameId);
    const hidden = request.body?.hidden === true;
    if (setStreamCategoryHidden.run(hidden ? 1 : 0, id).changes === 0) {
      throw new HttpRouteError(404, 'Saved stream category not found.');
    }
    response.json(listSavedStreamCategories());
  }));

  app.put('/api/stream-categories/:gameId/tags', handle((request, response) => {
    const id = normalizeGameId(request.params.gameId);
    if (!streamCategoryExists(id)) throw new HttpRouteError(404, 'Saved stream category not found.');
    setSavedStreamCategoryTags(id, (request.body as { tags?: unknown })?.tags);
    response.json(listSavedStreamCategories());
  }));

  app.delete('/api/stream-categories/:gameId', handle((request, response) => {
    const id = normalizeGameId(request.params.gameId);
    if (!deleteSavedStreamCategory(id)) throw new HttpRouteError(404, 'Saved stream category not found.');
    response.json(listSavedStreamCategories());
  }));

  app.get('/api/stream-tags', (request, response) => {
    const query = typeof request.query['query'] === 'string' ? request.query['query'] : '';
    response.json(suggestTagHistory(query));
  });
}
