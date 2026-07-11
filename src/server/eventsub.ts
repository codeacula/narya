import type { Express } from 'express';
import {
  EVENTSUB_RECONNECT_DELAY_MS,
  EVENTSUB_STALE_SOCKET_CLOSE_MS,
} from '../shared/constants';
import { fireAlert } from './alerts';
import { appConfig } from './appConfig';
import { getTriggerDispatcher } from './automation';
import { recordAutomodHold, resolveAutomodHold } from './automod';
import { onCategorySignal, reconcileCategoryModules } from './categoryModules';
import { db } from './db';
import { announceTwitchStreamOnline } from './goLive';
import { broadcast } from './realtime';
import { playRewardMedia } from './rewardMedia';
import type { RuntimeState } from './runtime';
import { endActiveStreamSession, getCurrentStreamSessionId } from './streamSession';
import { isTtsRewardEnabled, speakText } from './tts';
import { fetchBroadcasterId, fetchCurrentTwitchStream, getEventSubCredentials, runTwitchCommercial } from './twitch/api';

const insertStreamEvent = db.prepare(`
  insert or ignore into stream_events (id, kind, actor, detail, tone, received_at, session_id, actor_login)
  values (?, ?, ?, ?, ?, ?, ?, ?)
`);

const updateStreamEventDetail = db.prepare(`
  update stream_events set detail = ?, tone = ? where id = ?
`);

/** `actor` is the display name shown on screen; `actorLogin` addresses the viewer. */
function emitStreamEvent(kind: string, actor: string, detail: string, tone: string, actorLogin?: string): string {
  const id = crypto.randomUUID();
  const receivedAt = new Date().toISOString();
  const sessionId = getCurrentStreamSessionId();
  const login = actorLogin?.toLowerCase() || null;
  insertStreamEvent.run(id, kind, actor, detail, tone, receivedAt, sessionId, login);
  broadcast('stream:event', { id, kind, actor, detail, tone, ago: 'just now', receivedAt, sessionId });
  return id;
}

function loginOf(event: Record<string, unknown>, field = 'user_login'): string | undefined {
  const value = event[field];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function updateStreamEvent(id: string, detail: string, tone: string) {
  updateStreamEventDetail.run(detail, tone, id);
  broadcast('stream:event:update', { id, detail, tone });
}

function tierLabel(tier: string): string {
  if (tier === '2000') return 'Tier 2';
  if (tier === '3000') return 'Tier 3';
  return 'Tier 1';
}

// Twitch fires both channel.subscribe and channel.subscription.message for a
// resub, in no guaranteed order. Track the sub event we already emitted per user
// so the second notification updates that row instead of adding another. Kept in
// SQLite rather than memory: a restart between the two notifications would
// otherwise persist a duplicate 'sub' row forever.
const SUB_MERGE_WINDOW_MS = 60_000;

const selectRecentSub = db.prepare(
  'select event_id as eventId, has_message as hasMessage from sub_merge_state where user_key = ? and at > ?',
);
const upsertRecentSub = db.prepare(`
  insert into sub_merge_state (user_key, event_id, has_message, at)
  values (?, ?, ?, ?)
  on conflict(user_key) do update set
    event_id = excluded.event_id,
    has_message = excluded.has_message,
    at = excluded.at
`);
const deleteExpiredSubs = db.prepare('delete from sub_merge_state where at <= ?');
const deleteAllSubs = db.prepare('delete from sub_merge_state');

type RecentSub = { eventId: string; hasMessage: boolean };

function takeRecentSub(userKey: string, now: number): RecentSub | undefined {
  const cutoff = now - SUB_MERGE_WINDOW_MS;
  deleteExpiredSubs.run(cutoff);
  const row = selectRecentSub.get(userKey, cutoff) as { eventId: string; hasMessage: number } | undefined;
  if (!row) return undefined;
  return { eventId: row.eventId, hasMessage: row.hasMessage !== 0 };
}

function rememberRecentSub(userKey: string, eventId: string, hasMessage: boolean, now: number): void {
  upsertRecentSub.run(userKey, eventId, hasMessage ? 1 : 0, now);
}

export function resetSubMergeState() {
  deleteAllSubs.run();
}

function subMergeKey(event: Record<string, unknown>): string {
  const userId = event.user_id;
  if (typeof userId === 'string' && userId !== '') return userId;
  return String(event.user_name ?? '').toLowerCase();
}

/**
 * Automation must never take EventSub down with it. A trigger that throws (a bad
 * template, an OBS scene that no longer exists) is logged and dropped; the stream
 * event, the alert, and the reward media have already been handled by then.
 */
async function dispatchAutomation(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error) {
    console.error('Automation: EventSub dispatch failed:', error);
  }
}

function resubDetail(event: Record<string, unknown>): string {
  const months = Number(event.cumulative_months);
  const tier = tierLabel(event.tier as string);
  if (!Number.isFinite(months) || months <= 0) return `resub · ${tier}`;
  return `resub · ${tier} · ${months} month${months !== 1 ? 's' : ''}`;
}

export async function handleEventSubNotification(
  state: RuntimeState,
  type: string,
  event: Record<string, unknown>,
  // Named for the wire, not the domain: `eventId` is already taken inside
  // channel.subscribe for the stream_events row id, and deduping on the wrong
  // one would silently let a redelivery fire an Action twice.
  messageId: string | null = null,
) {
  switch (type) {
    // The category changed on Twitch, whoever changed it. `category_id` is
    // authoritative here — an empty one means the channel genuinely has no
    // category, not that we failed to read it, so it is safe to pass through as
    // null and stand every module down.
    case 'channel.update': {
      const gameId = typeof event.category_id === 'string' ? event.category_id.trim() : '';
      const gameName = typeof event.category_name === 'string' ? event.category_name.trim() : '';
      await onCategorySignal(state, 'channel_update', gameId || null, gameName || null);
      break;
    }
    case 'stream.online': {
      const streamId = typeof event.id === 'string' ? event.id : '';
      const startedAt = typeof event.started_at === 'string' ? event.started_at : new Date().toISOString();
      state.clearTwitchCaches();
      // stream.online carries no category, so re-read it rather than guess. This
      // also catches a category changed while Narya was down.
      const tasks: Promise<unknown>[] = [
        announceTwitchStreamOnline(streamId, startedAt, state),
        reconcileCategoryModules(state),
      ];
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
      emitStreamEvent('follow', event.user_name as string, 'followed', 'silver', loginOf(event));
      fireAlert('follow', { user: event.user_name as string });
      await dispatchAutomation(() => getTriggerDispatcher().handleTwitchEvent({
        kind: 'follow', eventId: messageId, actor: event.user_name as string, login: loginOf(event) ?? null,
      }));
      break;
    case 'channel.subscribe': {
      if (event.is_gift as boolean) break;
      const now = Date.now();
      const key = subMergeKey(event);
      // A channel.subscription.message already landed for this user and carries
      // the richer resub detail, so this notification adds nothing.
      if (takeRecentSub(key, now)) break;
      const eventId = emitStreamEvent('sub', event.user_name as string,
        `new sub · ${tierLabel(event.tier as string)}`, 'warning', loginOf(event));
      rememberRecentSub(key, eventId, false, now);
      // Fires once per sub. If channel.subscription.message arrives after this for a
      // resub, it only updates the stream_events detail (see below) — the alert has
      // already gone out with "new sub" wording. Accepted for v1.
      fireAlert('sub', { user: event.user_name as string, tier: tierLabel(event.tier as string), months: 1 });
      await dispatchAutomation(() => getTriggerDispatcher().handleTwitchEvent({
        kind: 'sub', eventId: messageId, actor: event.user_name as string, login: loginOf(event) ?? null,
        tier: tierLabel(event.tier as string), months: 1,
      }));
      break;
    }
    case 'channel.subscription.message': {
      const now = Date.now();
      const key = subMergeKey(event);
      const detail = resubDetail(event);
      const pending = takeRecentSub(key, now);
      if (pending && !pending.hasMessage) {
        updateStreamEvent(pending.eventId, detail, 'warning');
        rememberRecentSub(key, pending.eventId, true, now);
        break;
      }
      if (pending) break; // A duplicate message notification for the same resub.
      const eventId = emitStreamEvent('sub', event.user_name as string, detail, 'warning', loginOf(event));
      rememberRecentSub(key, eventId, true, now);
      fireAlert('sub', {
        user: event.user_name as string,
        tier: tierLabel(event.tier as string),
        months: Number(event.cumulative_months) || 1,
      });
      await dispatchAutomation(() => getTriggerDispatcher().handleTwitchEvent({
        kind: 'sub', eventId: messageId, actor: event.user_name as string, login: loginOf(event) ?? null,
        tier: tierLabel(event.tier as string), months: Number(event.cumulative_months) || 1,
      }));
      break;
    }
    case 'channel.subscription.gift': {
      const gifter = (event.user_name as string) || 'Anonymous';
      emitStreamEvent('gift', gifter,
        `gifted ${event.total} sub${(event.total as number) !== 1 ? 's' : ''} to the channel`, 'warning',
        loginOf(event));
      fireAlert('gift', { user: gifter, amount: event.total as number });
      await dispatchAutomation(() => getTriggerDispatcher().handleTwitchEvent({
        kind: 'gift', eventId: messageId, actor: gifter, login: loginOf(event) ?? null, amount: event.total as number,
      }));
      break;
    }
    case 'channel.cheer': {
      const cheerer = (event.user_name as string) || 'Anonymous';
      emitStreamEvent('cheer', cheerer, `cheered ${event.bits} bits`, 'info', loginOf(event));
      fireAlert('cheer', { user: cheerer, amount: event.bits as number });
      await dispatchAutomation(() => getTriggerDispatcher().handleTwitchEvent({
        kind: 'cheer', eventId: messageId, actor: cheerer, login: loginOf(event) ?? null, amount: event.bits as number,
      }));
      break;
    }
    case 'channel.raid':
      emitStreamEvent('raid',
        event.from_broadcaster_user_name as string,
        `raided with ${event.viewers} viewer${(event.viewers as number) !== 1 ? 's' : ''}`, 'note',
        loginOf(event, 'from_broadcaster_user_login'));
      fireAlert('raid', { user: event.from_broadcaster_user_name as string, amount: event.viewers as number });
      await dispatchAutomation(() => getTriggerDispatcher().handleTwitchEvent({
        kind: 'raid', eventId: messageId, actor: event.from_broadcaster_user_name as string,
        login: loginOf(event, 'from_broadcaster_user_login') ?? null, amount: event.viewers as number,
      }));
      break;
    case 'channel.channel_points_custom_reward_redemption.add': {
      const reward = event.reward as { id: string; title: string };
      emitStreamEvent('redeem', event.user_name as string, `redeemed "${reward.title}"`, 'info', loginOf(event));
      const userInput = typeof event.user_input === 'string' ? event.user_input.trim() : '';
      if (userInput && isTtsRewardEnabled(reward.id)) {
        void speakText(userInput).catch((err: unknown) => {
          console.error('TTS: failed to speak redemption text:', err);
        });
      }
      playRewardMedia(reward.id, event.user_name as string);
      await dispatchAutomation(() => getTriggerDispatcher().handleRewardRedemption({
        eventId: messageId,
        rewardId: reward.id,
        rewardTitle: reward.title,
        actor: event.user_name as string,
        login: loginOf(event) ?? null,
        userInput,
      }));
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
          `watch streak · ${streak.cumulative_months} month${streak.cumulative_months !== 1 ? 's' : ''}`, 'silver',
          loginOf(event, 'chatter_user_login'));
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
    case 'automod.message.hold': {
      const messageId = event.message_id;
      if (typeof messageId !== 'string' || messageId === '') {
        console.warn('EventSub: automod.message.hold without a message_id, ignoring');
        break;
      }
      const message = event.message as { text: string } | undefined;
      const automod = event.automod as { category?: string; level?: number } | undefined;
      recordAutomodHold({
        id: messageId,
        channel: (event.broadcaster_user_login as string) ?? appConfig.twitchChannel,
        username: (event.user_login as string) ?? 'unknown',
        displayName: (event.user_name as string) ?? (event.user_login as string) ?? 'unknown',
        message: message?.text ?? '',
        category: automod?.category ?? null,
        level: automod?.level ?? null,
        heldAt: (event.held_at as string) ?? new Date().toISOString(),
      });
      break;
    }
    case 'automod.message.update': {
      const messageId = event.message_id;
      if (typeof messageId !== 'string' || messageId === '') {
        console.warn('EventSub: automod.message.update without a message_id, ignoring');
        break;
      }
      // Twitch delivers these status values in lowercase; normalize defensively
      // so a casing change on either side can't misfile every resolution.
      const status = String(event.status ?? '').toLowerCase();
      let resolution: 'allowed' | 'denied' | 'expired';
      if (status === 'approved') resolution = 'allowed';
      else if (status === 'denied') resolution = 'denied';
      else if (status === 'expired') resolution = 'expired';
      else {
        console.warn(`EventSub: unrecognized automod.message.update status "${event.status}", treating as expired`);
        resolution = 'expired';
      }
      // Twitch's own verdict: it outranks any `expired` we recorded provisionally.
      resolveAutomodHold(
        messageId,
        resolution,
        (event.moderator_user_name as string) ?? null,
        { authoritative: true },
      );
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

// A connected socket with no working subscriptions is not a healthy service, so
// report what actually got established instead of a single boolean.
export type EventSubHealth = {
  // The stream.online/offline pair. Without these, go-live announcements and
  // session tracking are dead, so a failure here forces a reconnect.
  lifecycleOk: boolean;
  // Required types Twitch refused (lifecycle + interaction). Non-empty while
  // connected = degraded: the socket is up but those features are silently gone.
  failed: string[];
};

async function subscribeToAllEvents(
  clientId: string,
  userToken: string,
  sessionId: string,
  bid: string,
): Promise<EventSubHealth> {
  const lifecycleSubs: Array<[string, string, Record<string, string>]> = [
    ['stream.online', '1', { broadcaster_user_id: bid }],
    ['stream.offline', '1', { broadcaster_user_id: bid }],
  ];
  const interactionSubs: Array<[string, string, Record<string, string>]> = [
    // Category changes made outside Narya — the Twitch dashboard, the mobile app,
    // a co-host. Without this the module coordinator only ever hears about the
    // edits Narya itself makes, which is most of the point of category modules.
    ['channel.update', '2', { broadcaster_user_id: bid }],
    ['channel.follow', '2', { broadcaster_user_id: bid, moderator_user_id: bid }],
    ['channel.subscribe', '1', { broadcaster_user_id: bid }],
    ['channel.subscription.gift', '1', { broadcaster_user_id: bid }],
    ['channel.subscription.message', '1', { broadcaster_user_id: bid }],
    ['channel.cheer', '1', { broadcaster_user_id: bid }],
    ['channel.raid', '1', { to_broadcaster_user_id: bid }],
    ['channel.chat.notification', '1', { broadcaster_user_id: bid, user_id: bid }],
    ['automod.message.hold', '2', { broadcaster_user_id: bid, moderator_user_id: bid }],
    ['automod.message.update', '2', { broadcaster_user_id: bid, moderator_user_id: bid }],
  ];
  const optionalSubs: Array<[string, string, Record<string, string>]> = [
    ['channel.channel_points_custom_reward_redemption.add', '1', { broadcaster_user_id: bid }],
    ['channel.ad_break.begin', '1', { broadcaster_user_id: bid }],
    ['user.whisper.message', '1', { user_id: bid }],
  ];

  const required = [...lifecycleSubs, ...interactionSubs];
  const failed: Array<[string, string, Record<string, string>]> = [];

  for (const sub of required) {
    const ok = await createEventSubSubscription(clientId, userToken, sessionId, ...sub);
    if (!ok) failed.push(sub);
  }

  // One bounded retry pass: a Twitch 5xx or a dropped request shouldn't cost the
  // operator their follow alerts for the whole session. A scope/permission refusal
  // will fail again here and stay in `failed`, where it becomes visible status
  // rather than an endless reconnect loop.
  const stillFailed: string[] = [];
  if (failed.length > 0) {
    console.warn(`EventSub: ${failed.length} subscription(s) failed; retrying once...`);
    await new Promise(resolve => setTimeout(resolve, 2000));
    for (const sub of failed) {
      const ok = await createEventSubSubscription(clientId, userToken, sessionId, ...sub);
      if (!ok) stillFailed.push(sub[0]);
    }
  }

  // Best-effort extras: these depend on scopes an operator may deliberately not have
  // granted, so a failure here isn't reported as service degradation.
  for (const [type, version, condition] of optionalSubs) {
    await createEventSubSubscription(clientId, userToken, sessionId, type, version, condition);
  }

  const lifecycleOk = !lifecycleSubs.some(([type]) => stillFailed.includes(type));
  if (!lifecycleOk) {
    console.error('EventSub: Twitch stream lifecycle subscriptions failed; live announcements are unavailable');
  } else if (stillFailed.length > 0) {
    console.warn(
      `EventSub: degraded — ${stillFailed.join(', ')} unavailable. Re-authorize Twitch or check token scopes.`,
    );
  } else {
    console.log(`EventSub: all ${required.length} required subscriptions active`);
  }

  return { lifecycleOk, failed: stillFailed };
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
      // message_id is on the wire and is the automation dedupe key: a redelivered
      // notification must not invoke an Action twice.
      metadata: { message_type: string; message_id?: string };
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

    if (!msg?.metadata?.message_type) return;
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
            const health = await subscribeToAllEvents(creds.clientId, creds.userToken, session.id, state.broadcasterId);
            if (generation !== state.eventSubConnectGeneration) return;
            if (!health.lifecycleOk) {
              state.eventSubError = 'subscription_failed';
              state.eventSubFailedSubscriptions = health.failed;
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
            // Any channel.update we missed while disconnected is gone for good —
            // EventSub does not replay. Re-read the live category on every connect
            // so a category changed during an outage still lands.
            await reconcileCategoryModules(state);
            // Don't clear the error when subscriptions are missing: the socket is up,
            // but follows/subs/raids/AutoMod aren't arriving, and the dashboard has to
            // say so rather than showing a healthy service.
            state.eventSubFailedSubscriptions = health.failed;
            state.eventSubError = health.failed.length > 0 ? 'subscriptions_degraded' : null;
          } else {
            console.error(`EventSub: could not resolve broadcaster ID for "${appConfig.twitchChannel}"`);
            state.eventSubError = 'broadcaster_unresolved';
            clearKeepaliveTimer(state);
            try { ws.close(); } catch { /* ignore */ }
            scheduleReconnect(state);
          }
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
      void handleEventSubNotification(state, subType, event, msg.metadata.message_id ?? null).catch(error => {
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
