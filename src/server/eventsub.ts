import type { Express } from 'express';
import {
  EVENTSUB_RECONNECT_DELAY_MS,
  EVENTSUB_STALE_SOCKET_CLOSE_MS,
} from '../shared/constants';
import { appConfig } from './appConfig';
import { db } from './db';
import { announceTwitchStreamOnline } from './goLive';
import { broadcast } from './realtime';
import type { RuntimeState } from './runtime';
import { endActiveStreamSession } from './streamSession';
import { isTtsRewardEnabled, speakText } from './tts';
import { fetchBroadcasterId, fetchCurrentTwitchStream, getEventSubCredentials, runTwitchCommercial } from './twitch/api';

const insertStreamEvent = db.prepare(`
  insert or ignore into stream_events (id, kind, actor, detail, tone, received_at)
  values (?, ?, ?, ?, ?, ?)
`);

function emitStreamEvent(kind: string, actor: string, detail: string, tone: string) {
  const id = crypto.randomUUID();
  const receivedAt = new Date().toISOString();
  insertStreamEvent.run(id, kind, actor, detail, tone, receivedAt);
  broadcast('stream:event', { id, kind, actor, detail, tone, ago: 'just now', receivedAt });
}

function tierLabel(tier: string): string {
  if (tier === '2000') return 'Tier 2';
  if (tier === '3000') return 'Tier 3';
  return 'Tier 1';
}

export async function handleEventSubNotification(state: RuntimeState, type: string, event: Record<string, unknown>) {
  switch (type) {
    case 'stream.online': {
      const streamId = typeof event.id === 'string' ? event.id : '';
      const startedAt = typeof event.started_at === 'string' ? event.started_at : new Date().toISOString();
      state.clearTwitchCaches();
      const tasks: Promise<unknown>[] = [announceTwitchStreamOnline(streamId, startedAt, state)];
      if (streamId && state.streamStartAdStreamId !== streamId) {
        state.streamStartAdStreamId = streamId;
        tasks.push(runTwitchCommercial(state)
          .then(commercial => console.log(`Twitch ads: started a ${commercial.durationSeconds}s stream-start commercial.`))
          .catch(error => console.error('Twitch ads: stream-start commercial failed:', error)));
      }
      await Promise.all(tasks);
      break;
    }
    case 'stream.offline':
      state.clearTwitchCaches();
      endActiveStreamSession();
      break;
    case 'channel.follow':
      emitStreamEvent('follow', event.user_name as string, 'followed', 'silver');
      break;
    case 'channel.subscribe':
      if (!(event.is_gift as boolean)) {
        emitStreamEvent('sub', event.user_name as string,
          `subscribed · ${tierLabel(event.tier as string)}`, 'warning');
      }
      break;
    case 'channel.subscription.message':
      emitStreamEvent('sub', event.user_name as string,
        `resubscribed · ${event.cumulative_months} months · ${tierLabel(event.tier as string)}`, 'warning');
      break;
    case 'channel.subscription.gift':
      emitStreamEvent('gift',
        (event.user_name as string) || 'Anonymous',
        `gifted ${event.total} sub${(event.total as number) !== 1 ? 's' : ''} to the channel`, 'warning');
      break;
    case 'channel.cheer':
      emitStreamEvent('cheer',
        (event.user_name as string) || 'Anonymous',
        `cheered ${event.bits} bits`, 'info');
      break;
    case 'channel.raid':
      emitStreamEvent('raid',
        event.from_broadcaster_user_name as string,
        `raided with ${event.viewers} viewer${(event.viewers as number) !== 1 ? 's' : ''}`, 'note');
      break;
    case 'channel.channel_points_custom_reward_redemption.add': {
      const reward = event.reward as { id: string; title: string };
      emitStreamEvent('redeem', event.user_name as string, `redeemed "${reward.title}"`, 'info');
      const userInput = typeof event.user_input === 'string' ? event.user_input.trim() : '';
      if (userInput && isTtsRewardEnabled(reward.id)) {
        void speakText(userInput).catch((err: unknown) => {
          console.error('TTS: failed to speak redemption text:', err);
        });
      }
      break;
    }
    case 'channel.ad_break.begin': {
      const durationSecs = event.duration_seconds as number;
      const startedAt = new Date(event.started_at as string);
      state.adBreakEndsAt = new Date(startedAt.getTime() + durationSecs * 1000).toISOString();
      state.twitchAdScheduleCache = null;
      emitStreamEvent('ad_break', 'Twitch', `ad break · ${durationSecs}s`, 'info');
      break;
    }
    case 'channel.chat.notification': {
      const noticeType = event.notice_type as string;
      if (noticeType === 'watch_streak') {
        const streak = event.watch_streak as { cumulative_months: number };
        emitStreamEvent('redeem',
          event.chatter_user_name as string,
          `watch streak · ${streak.cumulative_months} month${streak.cumulative_months !== 1 ? 's' : ''}`, 'silver');
      }
      break;
    }
    case 'user.whisper.message': {
      const whisper = event.whisper as Record<string, unknown> | undefined;
      broadcast('whisper:message', {
        id: typeof event.whisper_id === 'string' ? event.whisper_id : crypto.randomUUID(),
        fromLogin: typeof event.from_user_login === 'string' ? event.from_user_login : 'unknown',
        fromDisplayName: typeof event.from_user_name === 'string' ? event.from_user_name : (event.from_user_login as string ?? 'unknown'),
        text: typeof whisper?.text === 'string' ? whisper.text : '',
        receivedAt: new Date().toISOString(),
      });
      break;
    }
  }
}

async function createEventSubSubscription(
  clientId: string,
  userToken: string,
  sessionId: string,
  type: string,
  version: string,
  condition: Record<string, string>,
): Promise<boolean> {
  try {
    const res = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
      method: 'POST',
      headers: {
        'Client-Id': clientId,
        'Authorization': `Bearer ${userToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ type, version, condition, transport: { method: 'websocket', session_id: sessionId } }),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(`EventSub: failed to subscribe to ${type} (${res.status}):`, text);
      return false;
    }
    console.log(`EventSub: subscribed to ${type}`);
    return true;
  } catch (err) {
    console.error(`EventSub: error subscribing to ${type}:`, err);
    return false;
  }
}

async function subscribeToAllEvents(clientId: string, userToken: string, sessionId: string, bid: string): Promise<boolean> {
  const lifecycleSubs: Array<[string, string, Record<string, string>]> = [
    ['stream.online', '1', { broadcaster_user_id: bid }],
    ['stream.offline', '1', { broadcaster_user_id: bid }],
  ];
  const interactionSubs: Array<[string, string, Record<string, string>]> = [
    ['channel.follow', '2', { broadcaster_user_id: bid, moderator_user_id: bid }],
    ['channel.subscribe', '1', { broadcaster_user_id: bid }],
    ['channel.subscription.gift', '1', { broadcaster_user_id: bid }],
    ['channel.subscription.message', '1', { broadcaster_user_id: bid }],
    ['channel.cheer', '1', { broadcaster_user_id: bid }],
    ['channel.raid', '1', { to_broadcaster_user_id: bid }],
    ['channel.chat.notification', '1', { broadcaster_user_id: bid, user_id: bid }],
  ];
  const optionalSubs: Array<[string, string, Record<string, string>]> = [
    ['channel.channel_points_custom_reward_redemption.add', '1', { broadcaster_user_id: bid }],
    ['channel.ad_break.begin', '1', { broadcaster_user_id: bid }],
    ['user.whisper.message', '1', { user_id: bid }],
  ];

  let lifecycleSuccessCount = 0;
  for (const [type, version, condition] of lifecycleSubs) {
    const ok = await createEventSubSubscription(clientId, userToken, sessionId, type, version, condition);
    if (ok) lifecycleSuccessCount++;
  }

  let successCount = 0;
  for (const [type, version, condition] of interactionSubs) {
    const ok = await createEventSubSubscription(clientId, userToken, sessionId, type, version, condition);
    if (ok) successCount++;
  }
  for (const [type, version, condition] of optionalSubs) {
    await createEventSubSubscription(clientId, userToken, sessionId, type, version, condition);
  }

  if (lifecycleSuccessCount !== lifecycleSubs.length) {
    console.error('EventSub: Twitch stream lifecycle subscriptions failed; live announcements are unavailable');
    return false;
  }
  if (successCount === 0) {
    console.warn('EventSub: interaction subscriptions failed — re-authorize Twitch or check token scopes');
  }

  console.log(`EventSub: ${lifecycleSuccessCount}/${lifecycleSubs.length} lifecycle and ${successCount}/${interactionSubs.length} interaction subscriptions active`);
  return true;
}

export function clearKeepaliveTimer(state: RuntimeState) {
  if (state.eventSubKeepaliveTimer !== null) {
    clearTimeout(state.eventSubKeepaliveTimer);
    state.eventSubKeepaliveTimer = null;
  }
}

function clearReconnectTimer(state: RuntimeState) {
  if (state.eventSubReconnectTimer !== null) {
    clearTimeout(state.eventSubReconnectTimer);
    state.eventSubReconnectTimer = null;
  }
}

function resetKeepaliveTimer(state: RuntimeState) {
  clearKeepaliveTimer(state);
  state.eventSubKeepaliveTimer = setTimeout(() => {
    console.log('EventSub: keepalive timeout, reconnecting...');
    disconnectEventSub(state);
    void connectEventSub(state);
  }, state.eventSubKeepaliveMs);
}

function scheduleReconnect(state: RuntimeState) {
  if (state.eventSubReconnectTimer !== null) return;
  state.eventSubReconnectTimer = setTimeout(() => {
    state.eventSubReconnectTimer = null;
    void connectEventSub(state);
  }, EVENTSUB_RECONNECT_DELAY_MS);
}

function isActiveSocket(socket: WebSocket | null): boolean {
  return socket?.readyState === WebSocket.CONNECTING || socket?.readyState === WebSocket.OPEN;
}

export function disconnectEventSub(state: RuntimeState) {
  state.eventSubConnectGeneration += 1;
  state.eventSubConnectPromise = null;
  state.eventSubReconnectInProgress = false;
  clearReconnectTimer(state);
  if (state.eventSubWs) {
    try {
      state.eventSubWs.close();
    } catch (error) {
      console.error('EventSub: failed to close WebSocket:', error);
    }
  }
  clearKeepaliveTimer(state);
  state.clearEventSubSocket();
}

export async function connectEventSub(state: RuntimeState, reconnectUrl?: string) {
  if (reconnectUrl) {
    if (state.eventSubReconnectInProgress) return;
    state.eventSubReconnectInProgress = true;
  } else {
    clearReconnectTimer(state);
    if (isActiveSocket(state.eventSubWs)) return;
    if (state.eventSubConnectPromise) return state.eventSubConnectPromise;
  }

  const previousSocket = state.eventSubWs;
  const generation = state.eventSubConnectGeneration;
  const connectTask = connectEventSubSocket(state, generation, reconnectUrl);
  if (!reconnectUrl) {
    state.eventSubConnectPromise = connectTask;
  }

  try {
    await connectTask;
    if (reconnectUrl && state.eventSubWs === previousSocket) {
      state.eventSubReconnectInProgress = false;
    }
  } catch (error) {
    if (reconnectUrl) state.eventSubReconnectInProgress = false;
    throw error;
  } finally {
    if (!reconnectUrl && state.eventSubConnectPromise === connectTask) {
      state.eventSubConnectPromise = null;
    }
  }
}

async function connectEventSubSocket(state: RuntimeState, generation: number, reconnectUrl?: string) {
  const creds = await getEventSubCredentials(state);
  if (generation !== state.eventSubConnectGeneration) return;

  if (!creds) {
    console.log('EventSub: no credentials configured, skipping');
    return;
  }

  if (!reconnectUrl && state.eventSubWs) {
    try {
      state.eventSubWs.close();
    } catch (error) {
      console.error('EventSub: failed to close existing WebSocket:', error);
    }
    state.eventSubWs = null;
  }
  state.eventSubConnected = false;

  const ws = new WebSocket(reconnectUrl ?? 'wss://eventsub.wss.twitch.tv/ws');
  state.eventSubWs = ws;

  ws.addEventListener('open', () => {
    console.log('EventSub: WebSocket connected');
  });

  ws.addEventListener('message', (evt) => {
    if (typeof evt.data !== 'string') return;

    type EventSubMsg = {
      metadata: { message_type: string };
      payload: {
        session?: { id: string; keepalive_timeout_seconds: number; reconnect_url?: string };
        subscription?: { type: string; status?: string };
        event?: Record<string, unknown>;
      };
    };

    let msg: EventSubMsg;
    try {
      msg = JSON.parse(evt.data);
    } catch (error) {
      console.error('EventSub: failed to parse WebSocket message:', error);
      return;
    }

    const msgType = msg.metadata.message_type;

    if (msgType === 'session_welcome') {
      const session = msg.payload.session!;
      state.eventSubConnected = true;
      state.eventSubKeepaliveMs = (session.keepalive_timeout_seconds + 10) * 1000;
      resetKeepaliveTimer(state);
      console.log(`EventSub: session ${session.id} established`);

      if (!reconnectUrl) {
        void (async () => {
          if (!state.broadcasterId) {
            state.broadcasterId = await fetchBroadcasterId(creds.clientId, creds.userToken);
          }
          if (generation !== state.eventSubConnectGeneration) return;
          if (state.broadcasterId) {
            const ok = await subscribeToAllEvents(creds.clientId, creds.userToken, session.id, state.broadcasterId);
            if (generation !== state.eventSubConnectGeneration) return;
            if (!ok) {
              state.eventSubError = 'subscription_failed';
              clearKeepaliveTimer(state);
              try { ws.close(); } catch { /* ignore */ }
              scheduleReconnect(state);
              return;
            }
            const currentStream = await fetchCurrentTwitchStream(creds.clientId, creds.userToken);
            if (currentStream) {
              try {
                await announceTwitchStreamOnline(currentStream.id, currentStream.startedAt, state);
              } catch (error) {
                console.error('EventSub: failed to reconcile the current Twitch stream:', error);
              }
            }
          } else {
            console.error(`EventSub: could not resolve broadcaster ID for "${appConfig.twitchChannel}"`);
          }
          state.eventSubError = null;
        })();
      } else {
        state.eventSubReconnectInProgress = false;
        state.eventSubError = null;
      }

    } else if (msgType === 'session_keepalive') {
      resetKeepaliveTimer(state);

    } else if (msgType === 'session_reconnect') {
      const newUrl = msg.payload.session?.reconnect_url;
      if (newUrl && ws === state.eventSubWs && !state.eventSubReconnectInProgress) {
        console.log('EventSub: reconnecting to new URL...');
        const staleWs = ws;
        void connectEventSub(state, newUrl);
        setTimeout(() => {
          try {
            staleWs.close();
          } catch (error) {
            console.error('EventSub: failed to close stale WebSocket:', error);
          }
        }, EVENTSUB_STALE_SOCKET_CLOSE_MS);
      }

    } else if (msgType === 'notification') {
      // A notification is proof the socket is alive. Twitch only sends keepalives while
      // otherwise idle, so during active streams events must reset the watchdog too —
      // otherwise a steady event flow starves the keepalive timer into a false reconnect.
      resetKeepaliveTimer(state);
      const subType = msg.payload.subscription?.type ?? '';
      const event = msg.payload.event ?? {};
      void handleEventSubNotification(state, subType, event).catch(error => {
        console.error(`EventSub: failed to handle ${subType}:`, error);
      });

    } else if (msgType === 'revocation') {
      const sub = msg.payload.subscription;
      console.warn('EventSub: subscription revoked:', sub?.type, sub?.status);
    }
  });

  ws.addEventListener('close', (evt) => {
    if (ws !== state.eventSubWs) return;
    state.eventSubReconnectInProgress = false;
    state.eventSubConnected = false;
    clearKeepaliveTimer(state);
    state.clearEventSubSocket();
    console.log(`EventSub: disconnected (code ${(evt as CloseEvent).code}), retrying in 10s...`);
    scheduleReconnect(state);
  });

  ws.addEventListener('error', () => {
    console.error('EventSub: WebSocket error');
  });
}

export function registerEventSubRoutes(app: Express, state: RuntimeState) {
  app.post('/api/eventsub/reconnect', (_req, res) => {
    disconnectEventSub(state);
    void connectEventSub(state);
    res.json({ ok: true });
  });
}
