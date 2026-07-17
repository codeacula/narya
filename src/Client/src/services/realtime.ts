// SignalR client for /hubs/realtime (see src/Narya.Api/Realtime/RealtimeHub.cs).
// The hub forwards every Redis-published realtime event to connected clients by
// invoking the client method "event" with (eventName, payload) — see
// RealtimeBroadcastService.HandleMessageAsync. onEvent() dispatches by that
// eventName so callers don't need to know about the hub's wire method at all.

import * as signalR from '@microsoft/signalr'

import { realtimeUrl } from './auth'

const HUB_PATH = '/hubs/realtime'
const CLIENT_METHOD = 'event'

type EventHandler = (payload: unknown) => void

const handlers = new Map<string, Set<EventHandler>>()

let connection: signalR.HubConnection | null = null

function getConnection(): signalR.HubConnection {
  if (!connection) {
    connection = new signalR.HubConnectionBuilder()
      .withUrl(realtimeUrl(HUB_PATH))
      .withAutomaticReconnect()
      .build()

    connection.on(CLIENT_METHOD, (eventName: string, payload: unknown) => {
      const set = handlers.get(eventName)
      if (!set) return
      for (const handler of set) handler(payload)
    })
  }
  return connection
}

/** Subscribe to a named realtime event (e.g. "settings:updated"). Returns an unsubscribe function. */
export function onEvent(name: string, handler: EventHandler): () => void {
  let set = handlers.get(name)
  if (!set) {
    set = new Set()
    handlers.set(name, set)
  }
  set.add(handler)

  return () => {
    set.delete(handler)
  }
}

export async function start(): Promise<void> {
  const conn = getConnection()
  if (conn.state === signalR.HubConnectionState.Disconnected) {
    await conn.start()
  }
}

export async function stop(): Promise<void> {
  if (connection && connection.state !== signalR.HubConnectionState.Disconnected) {
    await connection.stop()
  }
}
