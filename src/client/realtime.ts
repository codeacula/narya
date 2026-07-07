import React from 'react';
import { withToken } from './auth';

type Handler = (payload: unknown) => void;

// A single shared WebSocket connection for the whole app. Every useSocket() call
// registers a handler against this connection instead of opening its own socket,
// so app-wide listeners (service status, settings updates) don't multiply connections.
const handlers = new Map<string, Set<Handler>>();
let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function ensureSocket() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(withToken(`${protocol}://${window.location.host}/socket`));

  socket.addEventListener('message', (messageEvent) => {
    let data: { event?: string; payload?: unknown };
    try {
      data = JSON.parse(messageEvent.data) as { event?: string; payload?: unknown };
    } catch {
      return;
    }
    if (!data.event) return;
    const listeners = handlers.get(data.event);
    if (!listeners) return;
    for (const listener of listeners) listener(data.payload);
  });

  socket.addEventListener('close', () => {
    socket = null;
    if (handlers.size > 0 && !reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        ensureSocket();
      }, 2000);
    }
  });
}

function subscribe(event: string, handler: Handler): () => void {
  let set = handlers.get(event);
  if (!set) {
    set = new Set();
    handlers.set(event, set);
  }
  set.add(handler);
  ensureSocket();

  return () => {
    const listeners = handlers.get(event);
    if (!listeners) return;
    listeners.delete(handler);
    if (listeners.size === 0) handlers.delete(event);
  };
}

export function useSocket<T>(event: string, onPayload: (payload: T) => void) {
  React.useEffect(() => {
    return subscribe(event, onPayload as Handler);
  }, [event, onPayload]);
}
