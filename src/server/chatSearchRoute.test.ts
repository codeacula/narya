import { afterAll, beforeAll, expect, test } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { db } from './db';
import { registerCoreRoutes } from './routes';
import { RuntimeState } from './runtime';

let server: Server;
let port = 0;

beforeAll(async () => {
  const app = express();
  registerCoreRoutes(app, new RuntimeState());
  server = app.listen(0);
  await new Promise<void>(resolve => server.once('listening', resolve));
  port = (server.address() as AddressInfo).port;
  db.exec('delete from chat_messages');
  db.prepare(`insert into chat_messages (id, channel, username, display_name, message, received_at)
    values ('route-1', 'test', 'viewer', 'Viewer', ?, ?)`).run('a'.repeat(500), new Date().toISOString());
});

afterAll(async () => {
  db.exec('delete from chat_messages');
  await new Promise<void>(resolve => server.close(() => resolve()));
});

function search(q: string) {
  return fetch(`http://127.0.0.1:${port}/api/chat/search?q=${encodeURIComponent(q)}`);
}

test('a query as long as a chat message can still match one', async () => {
  const response = await search('a'.repeat(500));
  expect(response.status).toBe(200);
  expect((await response.json() as Array<{ id: string }>).map(hit => hit.id)).toEqual(['route-1']);
});

test('a query longer than any chat message is rejected rather than searched', async () => {
  const response = await search('a'.repeat(501));
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: 'q can be at most 500 characters, the length of a chat message' });
});

test('the length limit counts characters, not UTF-16 units', async () => {
  // 500 emoji are 1000 UTF-16 units but 500 characters.
  expect((await search('😀'.repeat(500))).status).toBe(200);
  expect((await search('😀'.repeat(501))).status).toBe(400);
});

test('an empty query is still rejected', async () => {
  expect((await search('   ')).status).toBe(400);
});
