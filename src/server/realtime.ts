import { createServer } from 'node:http';
import express from 'express';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { isOverlayEvent, webSocketRole, type AuthRole } from './auth';

export const app = express();
app.use(express.json());

export const server = createServer(app);

// Role per connection, so an overlay browser source only receives the events it
// renders — never whispers, AutoMod holds, or operator status.
const sockets = new Map<WsSocket, AuthRole>();
const wss = new WebSocketServer({ server, path: '/socket' });

wss.on('connection', (socket, request) => {
  const role = webSocketRole(request.url);
  if (!role) {
    socket.close(1008, 'unauthorized');
    return;
  }
  sockets.set(socket, role);
  socket.on('close', () => sockets.delete(socket));
});

export function getSocketCount(): number {
  return sockets.size;
}

export function broadcast(event: string, payload: unknown) {
  const message = JSON.stringify({ event, payload });
  for (const [socket, role] of sockets) {
    if (socket.readyState !== socket.OPEN) continue;
    if (role === 'overlay' && !isOverlayEvent(event)) continue;
    socket.send(message, (error) => {
      if (error) console.error(`Realtime: failed to send ${event}:`, error);
    });
  }
}
