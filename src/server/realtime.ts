import { createServer } from 'node:http';
import express from 'express';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { isWebSocketTokenValid } from './auth';

export const app = express();
app.use(express.json());

export const server = createServer(app);

const sockets = new Set<WsSocket>();
const wss = new WebSocketServer({ server, path: '/socket' });

wss.on('connection', (socket, request) => {
  if (!isWebSocketTokenValid(request.url)) {
    socket.close(1008, 'unauthorized');
    return;
  }
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});

export function getSocketCount(): number {
  return sockets.size;
}

export function broadcast(event: string, payload: unknown) {
  const message = JSON.stringify({ event, payload });
  for (const socket of sockets) {
    if (socket.readyState !== socket.OPEN) continue;
    socket.send(message, (error) => {
      if (error) console.error(`Realtime: failed to send ${event}:`, error);
    });
  }
}
