import { createServer } from 'node:http';
import express from 'express';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { isWebSocketTokenValid } from './auth';

export const app = express();
app.use(express.json());

export const server = createServer(app);

const sockets = new Set<WsSocket>();
/** Clients that identified themselves as the dedicated clip player. */
const clipPlayers = new Set<WsSocket>();
const wss = new WebSocketServer({ server, path: '/socket' });

function socketRole(url: string | undefined): string {
  const role = new URL(url ?? '/', 'http://localhost').searchParams.get('role');
  return role ?? '';
}

wss.on('connection', (socket, request) => {
  if (!isWebSocketTokenValid(request.url)) {
    socket.close(1008, 'unauthorized');
    return;
  }
  sockets.add(socket);
  if (socketRole(request.url) === CLIP_PLAYER_ROLE) clipPlayers.add(socket);
  socket.on('close', () => {
    sockets.delete(socket);
    clipPlayers.delete(socket);
  });
});

export const CLIP_PLAYER_ROLE = 'clip-player';

export function getSocketCount(): number {
  return sockets.size;
}

export function getClipPlayerCount(): number {
  return [...clipPlayers].filter(socket => socket.readyState === socket.OPEN).length;
}

function send(targets: Iterable<WsSocket>, event: string, payload: unknown) {
  const message = JSON.stringify({ event, payload });
  for (const socket of targets) {
    if (socket.readyState !== socket.OPEN) continue;
    socket.send(message, (error) => {
      if (error) console.error(`Realtime: failed to send ${event}:`, error);
    });
  }
}

export function broadcast(event: string, payload: unknown) {
  send(sockets, event, payload);
}

/**
 * Redeem media goes to the /overlay/clips browser source when one is connected.
 * When none is — OBS closed, source never added — it falls back to every other
 * client so the dashboard can play it. Without the fallback a redeem is silently
 * swallowed even though the viewer already spent their points.
 */
export function pickMediaTargets<T extends { readyState: number; OPEN: number }>(
  all: readonly T[],
  players: readonly T[],
): T[] {
  const livePlayers = players.filter(socket => socket.readyState === socket.OPEN);
  if (livePlayers.length > 0) return livePlayers;
  return all.filter(socket => socket.readyState === socket.OPEN);
}

export function broadcastMedia(event: string, payload: unknown) {
  send(pickMediaTargets([...sockets], [...clipPlayers]), event, payload);
}
