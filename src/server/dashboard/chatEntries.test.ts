import { afterAll, beforeAll, expect, test } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ChatEntry } from '../../shared/api';
import { db } from '../db';
import { RuntimeState } from '../runtime';
import { registerDashboardRoutes } from './status';

let server: Server;
let port = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  registerDashboardRoutes(app, new RuntimeState());
  server = app.listen(0);
  await new Promise<void>(resolve => server.once('listening', resolve));
  port = (server.address() as AddressInfo).port;
  db.exec('delete from chat_messages');
  const insert = db.prepare(`insert into chat_messages
    (id, channel, username, display_name, message, received_at, deleted_at, deleted_reason)
    values (?, 'test', ?, ?, ?, ?, ?, ?)`);
  insert.run('live-1', 'viewer', 'Viewer', 'hello', '2026-11-14T18:00:00.000Z', null, null);
  insert.run('gone-1', 'spammer', 'Spammer', 'buy followers', '2026-11-14T18:01:00.000Z',
    '2026-11-14T18:01:05.000Z', 'message deleted by moderator');
});

afterAll(async () => {
  db.exec('delete from chat_messages');
  await new Promise<void>(resolve => server.close(() => resolve()));
});

async function get(path: string): Promise<ChatEntry[]> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  expect(response.status).toBe(200);
  return await response.json() as ChatEntry[];
}

// A removed message used to come back with no trace of its removal, so the dashboard
// rendered it as live chat and offered pin/timeout/ban on it.
test('the dashboard feed carries a removed message\'s deleted state and reason', async () => {
  const entries = await get('/api/dashboard/chat');
  const byId = Object.fromEntries(entries.map(entry => [entry.id, entry]));
  expect(byId['gone-1']?.deletedAt).toBe('2026-11-14T18:01:05.000Z');
  expect(byId['gone-1']?.deletedReason).toBe('message deleted by moderator');
  expect(byId['live-1']?.deletedAt).toBeNull();
});

test('older pages carry it too', async () => {
  const entries = await get('/api/dashboard/chat?before=live-1');
  expect(entries).toEqual([]);
  const older = await get(`/api/dashboard/chat?before=gone-1`);
  expect(older.map(entry => entry.id)).toEqual(['live-1']);
  expect(older[0]?.deletedAt).toBeNull();
});

test('a viewer\'s history page carries it', async () => {
  const entries = await get('/api/viewers/spammer/messages');
  expect(entries.map(entry => [entry.id, entry.deletedReason])).toEqual([['gone-1', 'message deleted by moderator']]);
});
