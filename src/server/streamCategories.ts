import type express from 'express';
import type { SavedStreamCategory } from '../shared/api';
import { db } from './db';
import { HttpRouteError, sendRouteError } from './http';

const listStreamCategoriesRow = db.prepare(`
  select game_id as id, game_name as name, box_art_url as boxArtUrl, hidden
  from stream_categories
  order by game_name collate nocase
`);
const getStreamCategoryRow = db.prepare(`select game_id from stream_categories where game_id = ?`);
const upsertStreamCategory = db.prepare(`
  insert into stream_categories (game_id, game_name, box_art_url, hidden, created_at)
  values (?, ?, ?, 0, ?)
  on conflict(game_id) do update set
    game_name = excluded.game_name,
    box_art_url = excluded.box_art_url,
    hidden = 0
`);
const setStreamCategoryHidden = db.prepare(`update stream_categories set hidden = ? where game_id = ?`);

type StreamCategoryRow = { id: string; name: string; boxArtUrl: string | null; hidden: number };

function listStreamCategories(): SavedStreamCategory[] {
  return (listStreamCategoriesRow.all() as StreamCategoryRow[]).map(row => ({
    id: row.id,
    name: row.name,
    boxArtUrl: row.boxArtUrl ?? null,
    hidden: row.hidden === 1,
  }));
}

function normalizeGameId(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!/^\d{1,20}$/.test(id)) throw new HttpRouteError(400, 'A valid Twitch category id is required.');
  return id;
}

export function registerStreamCategoryRoutes(app: express.Express) {
  app.get('/api/stream-categories', (_request, response) => {
    response.json(listStreamCategories());
  });

  app.post('/api/stream-categories', (request, response) => {
    try {
      const id = normalizeGameId(request.body?.id);
      const name = typeof request.body?.name === 'string' ? request.body.name.trim() : '';
      if (!name) throw new HttpRouteError(400, 'Category name is required.');
      const boxArtUrl = typeof request.body?.boxArtUrl === 'string' && request.body.boxArtUrl.trim()
        ? request.body.boxArtUrl.trim()
        : null;
      upsertStreamCategory.run(id, name.slice(0, 160), boxArtUrl, new Date().toISOString());
      response.status(201).json(listStreamCategories());
    } catch (error) {
      sendRouteError(response, error);
    }
  });

  app.patch('/api/stream-categories/:gameId', (request, response) => {
    try {
      const id = normalizeGameId(request.params.gameId);
      if (!getStreamCategoryRow.get(id)) throw new HttpRouteError(404, 'Saved stream category not found.');
      const hidden = request.body?.hidden === true;
      setStreamCategoryHidden.run(hidden ? 1 : 0, id);
      response.json(listStreamCategories());
    } catch (error) {
      sendRouteError(response, error);
    }
  });
}
