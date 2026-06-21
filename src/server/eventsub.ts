import {
  EVENTSUB_RECONNECT_DELAY_MS,
  EVENTSUB_STALE_SOCKET_CLOSE_MS,
} from '../shared/constants';
import { config } from './config';
import { db } from './db';
import { broadcast } from './realtime';
import type { RuntimeState } from './runtime';
import { fetchBroadcasterId, getEventSubCredentials } from './twitch/api';

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

function handleEventSubNotification(state: RuntimeState, type: string, event: Record<string, unknown>) {
  switch (type) {
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
    case 'channel.channel_points_custom_reward_redemption.add':
      emitStreamEvent('redeem',
        event.user_name as string,
        `redeemed "${(event.reward as { title: string }).title}"`, 'info');
      break;
    case 'channel.ad_break.begin': {
      const durationSecs = event.duration_seconds as number;
      const startedAt = new Date(event.started_at as string);
      state.adBreakEndsAt = new Date(startedAt.getTime() + durationSecs * 1000).toISOString();
      state.twitchAdScheduleCache = null;
      emitStreamEvent('redeem', 'Twitch', `ad break · ${durationSecs}s`, 'info');
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
  }
}

async function createEventSubSubscription(
  clientId: string,
  userToken: string,
  sessionId: string,
  type: string,
  version: string,
  condition: Record<string, string>,
) {
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
    }
  } catch (err) {
    console.error(`EventSub: error subscribing to ${type}:`, err);
  }
}

async function subscribeToAllEvents(clientId: string, userToken: string, sessionId: string, bid: string) {
  const subs: Array<[string, string, Record<string, string>]> = [
    ['channel.follow', '2', { broadcaster_user_id: bid, moderator_user_id: bid }],
    ['channel.subscribe', '1', { broadcaster_user_id: bid }],
    ['channel.subscription.gift', '1', { broadcaster_user_id: bid }],
    ['channel.subscription.message', '1', { broadcaster_user_id: bid }],
    ['channel.cheer', '1', { broadcaster_user_id: bid }],
    ['channel.raid', '1', { to_broadcaster_user_id: bid }],
    ['channel.channel_points_custom_reward_redemption.add', '1', { broadcaster_user_id: bid }],
    ['channel.ad_break.begin', '1', { broadcaster_user_id: bid }],
    ['channel.chat.notification', '1', { broadcaster_user_id: bid, user_id: bid }],
  ];
  for (const [type, version, condition] of subs) {
    await createEventSubSubscription(clientId, userToken, sessionId, type, version, condition);
  }
  console.log('EventSub: all subscriptions created');
}

export function clearKeepaliveTimer(state: RuntimeState) {
  if (state.eventSubKeepaliveTimer !== null) {
    clearTimeout(state.eventSubKeepaliveTimer);
    state.eventSubKeepaliveTimer = null;
  }
}

function resetKeepaliveTimer(state: RuntimeState) {
  clearKeepaliveTimer(state);
  state.eventSubKeepaliveTimer = setTimeout(() => {
    console.log('EventSub: keepalive timeout, reconnecting...');
    void connectEventSub(state);
  }, state.eventSubKeepaliveMs);
}

export function disconnectEventSub(state: RuntimeState) {
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
  const creds = await getEventSubCredentials(state);
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
          if (state.broadcasterId) {
            await subscribeToAllEvents(creds.clientId, creds.userToken, session.id, state.broadcasterId);
          } else {
            console.error(`EventSub: could not resolve broadcaster ID for "${config.twitchChannel}"`);
          }
        })();
      }

    } else if (msgType === 'session_keepalive') {
      resetKeepaliveTimer(state);

    } else if (msgType === 'session_reconnect') {
      const newUrl = msg.payload.session?.reconnect_url;
      if (newUrl) {
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
      const subType = msg.payload.subscription?.type ?? '';
      const event = msg.payload.event ?? {};
      handleEventSubNotification(state, subType, event);

    } else if (msgType === 'revocation') {
      const sub = msg.payload.subscription;
      console.warn('EventSub: subscription revoked:', sub?.type, sub?.status);
    }
  });

  ws.addEventListener('close', (evt) => {
    if (ws !== state.eventSubWs) return;
    state.eventSubConnected = false;
    clearKeepaliveTimer(state);
    console.log(`EventSub: disconnected (code ${(evt as CloseEvent).code}), retrying in 10s...`);
    setTimeout(() => { void connectEventSub(state); }, EVENTSUB_RECONNECT_DELAY_MS);
  });

  ws.addEventListener('error', () => {
    console.error('EventSub: WebSocket error');
  });
}
