import { appConfig } from './appConfig';
import { redisPublish, streamPrefix } from './redis';
import type { NaryaEventEnvelope, NaryaEventType } from '../shared/api';

const RETENTION_MS = 48 * 60 * 60 * 1000; // ~48h rolling window (MINID trim)
// Dev/prod isolation: the stream key is `narya:<prefix>:events`. When a dev box and
// production share the SAME redisUrl they must NOT land on the same key, or a dev
// redeem reaches a prod consumer (and back). The prefix resolution lives in redis.ts
// (`streamPrefix()`) as the ONE source of truth shared with the inbound per-app streams
// (`narya:<prefix>:inbound:<appId>`), so the outbound and inbound keys can never drift.
// Production leaves the environment unset and publishes to `narya:prod:events`;
// `bun run dev:server` sets STREAMER_TOOLS_REDIS_PREFIX=dev (see package.json) so a dev
// box publishes to `narya:dev:events`.
function streamKey(): string { return `narya:${streamPrefix()}:events`; }
function minId(now: number): string { return `${now - RETENTION_MS}-0`; }

type Channel = { id: string; login: string };

export function buildEnvelope(type: NaryaEventType, id: string, channel: Channel, data: Record<string, unknown>): NaryaEventEnvelope {
  return { version: 1, id, type, ts: new Date().toISOString(), channel, source: 'narya', data };
}

function publish(type: NaryaEventType, sourceId: string | null, channel: Channel, data: Record<string, unknown>): void {
  if (!appConfig.redisUrl) return; // fully-optional: no url -> true no-op
  const id = sourceId ?? crypto.randomUUID();
  const envelope = buildEnvelope(type, id, channel, data);
  const now = Date.now();
  // Fire-and-forget: NEVER awaited on the redeem/chat/module path. A throwing/hanging bus is swallowed.
  void redisPublish(streamKey(), minId(now), JSON.stringify(envelope))
    .catch((error) => { console.error('Redis publish failed:', error instanceof Error ? error.message : error); });
}

export function publishRedeem(input: {
  sourceId: string | null; channel: Channel;
  rewardId: string; rewardTitle: string; rewardSource: string | null; rewardExternalRef: string | null;
  redemptionId: string | null; userId: string; userLogin: string; userInput: string;
}): void {
  publish('redeem', input.sourceId, input.channel, {
    rewardId: input.rewardId, rewardTitle: input.rewardTitle,
    rewardSource: input.rewardSource, rewardExternalRef: input.rewardExternalRef,
    redemptionId: input.redemptionId, userId: input.userId, userLogin: input.userLogin, userInput: input.userInput,
  });
}

export function publishTwitchEvent(input: {
  sourceId: string | null; channel: Channel;
  eventKind: string; actorUserId: string; actorLogin: string; amount?: number; tier?: string;
}): void {
  publish('twitch_event', input.sourceId, input.channel, {
    eventKind: input.eventKind, actorUserId: input.actorUserId, actorLogin: input.actorLogin,
    amount: input.amount ?? null, tier: input.tier ?? null,
  });
}

export function publishModuleSwitch(input: {
  channel: Channel; fromModuleId: string | null; toModuleId: string | null; categoryId: string | null; categoryName: string | null;
}): void {
  publish('module_switch', null, input.channel, {
    fromModuleId: input.fromModuleId, toModuleId: input.toModuleId,
    categoryId: input.categoryId, categoryName: input.categoryName,
  });
}
