import type express from 'express';
import type { ViewerReward, ViewerRewardUpsert } from '../shared/api';
import { appFromRequest } from './auth';
import { isUniqueConstraintError } from './db';
import { handle, HttpRouteError } from './http';
import {
  findRewardByExternalRef,
  listRewardIdsBySource,
  ownsReward,
  setRewardSourceWithRef,
} from './rewardProvenance';
import type { RuntimeState } from './runtime';
import { getTwitchActionCredentials } from './twitch/api';
import {
  createTwitchReward,
  deleteTwitchReward,
  fetchRewards,
  forgetRewardLocalState,
  normalizeReward,
  REWARD_SCOPE,
  sendTwitchRewardUpdate,
  twitchRewardBody,
} from './viewerRewards';

/**
 * The app-facing reward surface. Every reward on the channel is minted under ONE
 * Twitch client_id with the operator's OAuth token, so Twitch's own `canManage` is
 * true for every narya-created reward no matter which app asked for it — Twitch
 * enforces nothing between apps. `reward_provenance.source` is therefore the only
 * isolation boundary, and it is enforced here:
 *
 *  - `source` comes from the app TOKEN, always. It is never read from a body or a
 *    query param anywhere in this file; a body-supplied `source` is ignored outright.
 *  - Every by-id route gates on `ownsReward(id, source)` and answers 404 on a miss —
 *    never 403, because a 403 confirms to a caller that the reward exists.
 *
 * The guard is mounted once on the whole prefix (`app.use('/api/ext', requireAppToken)`
 * in index.ts), not per route, because requireDashboardToken deliberately next()s
 * every /api/ext/* request with zero auth.
 */

// An explicit projection of ViewerReward, NOT a type alias — the operator's UI type
// is free to grow new fields without silently expanding this public app contract.
// `categoryId` (the operator's reward-group UUID) and `canManage` (Twitch's own
// manageable-by-this-client_id flag, true for every narya reward regardless of which
// app asked for it) are operator-internal and deliberately never appear here.
export type AppReward = {
  id: string;
  title: string;
  prompt: string;
  cost: number;
  isEnabled: boolean;
  isPaused: boolean;
  isInStock: boolean;
  imageUrl: string | null;
  backgroundColor: string;
  isUserInputRequired: boolean;
  skipQueue: boolean;
  globalCooldown: { enabled: boolean; seconds: number };
  maxPerStream: { enabled: boolean; max: number };
  maxPerUserPerStream: { enabled: boolean; max: number };
  source: string | null;
};

export type AppRewardListResponse = { rewards: AppReward[] };
export type AppRewardRef = { id: string; source: string };
export type AppRewardCreateResult = AppRewardRef & { externalRef: string; created: boolean };

function toAppReward(reward: ViewerReward): AppReward {
  return {
    id: reward.id,
    title: reward.title,
    prompt: reward.prompt,
    cost: reward.cost,
    isEnabled: reward.isEnabled,
    isPaused: reward.isPaused,
    isInStock: reward.isInStock,
    imageUrl: reward.imageUrl,
    backgroundColor: reward.backgroundColor,
    isUserInputRequired: reward.isUserInputRequired,
    skipQueue: reward.skipQueue,
    globalCooldown: reward.globalCooldown,
    maxPerStream: reward.maxPerStream,
    maxPerUserPerStream: reward.maxPerUserPerStream,
    source: reward.source,
  };
}

const MAX_EXTERNAL_REF_LENGTH = 200;

/** The acting app's name — the provenance `source` for every row this surface touches. */
function sourceFor(request: express.Request): string {
  const app = appFromRequest(request);
  // Unreachable while the prefix guard is mounted; fail closed rather than trust it.
  if (!app) throw new HttpRouteError(401, 'Unauthorized');
  return app.name;
}

/** 404 on a reward this app did not provision — including one owned by another app,
 *  by the operator ('narya'), or created by hand ('manual'). */
function requireOwnedReward(rewardId: string, source: string): string {
  if (!ownsReward(rewardId, source)) throw new HttpRouteError(404, 'Reward not found.');
  return rewardId;
}

function normalizeExternalRef(value: unknown): string {
  const ref = typeof value === 'string' ? value.trim() : '';
  if (!ref) throw new HttpRouteError(400, 'external_ref is required — it is this reward\'s idempotency key.');
  if (ref.length > MAX_EXTERNAL_REF_LENGTH) {
    throw new HttpRouteError(400, `external_ref must be ${MAX_EXTERNAL_REF_LENGTH} characters or fewer.`);
  }
  return ref;
}

// The body is read field by field on purpose. `source` is NOT in this list — it comes
// from the token — and neither is `categoryId`: reward-group membership is operator
// configuration, and an app must not be able to move a reward between the operator's
// groups. On a PATCH, an omitted field keeps its current Twitch value.
function normalizeAppReward(body: Record<string, unknown>, current: ViewerReward | null): ViewerRewardUpsert {
  const pick = (key: string, fallback: unknown) => (body[key] === undefined ? fallback : body[key]);
  return normalizeReward({
    title: pick('title', current?.title),
    prompt: pick('prompt', current?.prompt),
    cost: pick('cost', current?.cost),
    isEnabled: pick('isEnabled', current?.isEnabled),
    isPaused: pick('isPaused', current?.isPaused),
    isUserInputRequired: pick('isUserInputRequired', current?.isUserInputRequired),
    skipQueue: pick('skipQueue', current?.skipQueue),
    backgroundColor: pick('backgroundColor', current?.backgroundColor),
    globalCooldown: pick('globalCooldown', current?.globalCooldown),
    maxPerStream: pick('maxPerStream', current?.maxPerStream),
    maxPerUserPerStream: pick('maxPerUserPerStream', current?.maxPerUserPerStream),
  });
}

function requestBody(request: express.Request): Record<string, unknown> {
  const body = request.body as unknown;
  return typeof body === 'object' && body !== null ? body as Record<string, unknown> : {};
}

export function registerAppRewardRoutes(app: express.Express, state: RuntimeState) {
  app.get('/api/ext/rewards', handle(async (request, response) => {
    const source = sourceFor(request);
    const owned = new Set(listRewardIdsBySource(source));
    const credentials = await getTwitchActionCredentials(state, REWARD_SCOPE);
    // Provenance rows joined to live Twitch state: a reward the operator deleted on
    // Twitch is simply absent rather than reported as still provisioned.
    const rewards = await fetchRewards(credentials);
    response.json({
      rewards: rewards.filter(reward => owned.has(reward.id)).map(toAppReward),
    } satisfies AppRewardListResponse);
  }));

  app.post('/api/ext/rewards', handle(async (request, response) => {
    const source = sourceFor(request);
    const body = requestBody(request);
    const externalRef = normalizeExternalRef(body.external_ref);

    // Idempotency is resolved BEFORE any Twitch call: a retried provision must never
    // mint a second reward out of the channel's shared, capped pool. The existing
    // reward is returned without touching Twitch at all.
    const existing = findRewardByExternalRef(source, externalRef);
    if (existing) {
      response.json({ id: existing, source, externalRef, created: false } satisfies AppRewardCreateResult);
      return;
    }

    const reward = normalizeAppReward(body, null);
    const credentials = await getTwitchActionCredentials(state, REWARD_SCOPE);
    // The cap diagnostic is audience-scoped: this caller may be told its OWN
    // consumption but never another source's — see toRewardCreateError.
    const created = await createTwitchReward(credentials, reward, reward.isEnabled, { kind: 'app', source });
    try {
      setRewardSourceWithRef(created.id, source, externalRef);
    } catch (error) {
      // The Twitch create is the non-transactional step, and the idempotency read
      // happened before it, so two requests racing the same ref both reach here having
      // both minted a reward. The loser compensates: without the delete its reward
      // stays on the channel unattributed, self-heals to 'manual' on the next list, and
      // is then indistinguishable from one the operator made by hand — a slot silently
      // consumed out of a pool that has no quota protecting it. Deleting is safe
      // precisely because the 409 means the id was never returned, so nothing can
      // depend on it.
      if (isUniqueConstraintError(error)) {
        try {
          await deleteTwitchReward(credentials, created.id);
          console.error(`Rolled back a raced reward create: deleted orphan reward ${created.id} (source ${source}, external_ref ${externalRef}).`);
        } catch (deleteError) {
          // Never swallowed into a 500: the caller's answer is still "someone else
          // claimed this ref", and the operator gets the id they must clean up by hand.
          console.error(`Orphan reward ${created.id} (source ${source}, external_ref ${externalRef}) could not be rolled back after a raced create:`, deleteError);
        }
        throw new HttpRouteError(409, 'That external_ref was just claimed by another request for this app.');
      }
      throw error;
    }
    response.status(201).json({ id: created.id, source, externalRef, created: true } satisfies AppRewardCreateResult);
  }));

  app.patch('/api/ext/rewards/:id', handle(async (request, response) => {
    const source = sourceFor(request);
    const rewardId = requireOwnedReward(request.params.id, source);
    const credentials = await getTwitchActionCredentials(state, REWARD_SCOPE);
    // Twitch is the source of truth for the fields the caller left out, so the current
    // reward is read before the merge rather than assumed from provenance.
    const current = (await fetchRewards(credentials)).find(reward => reward.id === rewardId);
    if (!current) throw new HttpRouteError(404, 'Reward not found.');
    const reward = normalizeAppReward(requestBody(request), current);
    await sendTwitchRewardUpdate(credentials, rewardId, twitchRewardBody(reward, reward.isEnabled, true));
    response.json({ id: rewardId, source } satisfies AppRewardRef);
  }));

  app.delete('/api/ext/rewards/:id', handle(async (request, response) => {
    const source = sourceFor(request);
    const rewardId = requireOwnedReward(request.params.id, source);
    const credentials = await getTwitchActionCredentials(state, REWARD_SCOPE);
    try {
      await deleteTwitchReward(credentials, rewardId);
    } catch (error) {
      // A reward the operator already deleted from Twitch's own dashboard is not a
      // delete failure — it is already deleted. Swallowing exactly the 404 here (and
      // only here, not in the operator route) lets forgetRewardLocalState still run
      // below and clear the provenance row, which is what lets the app re-POST the
      // same external_ref and get a fresh reward instead of being wedged on a dead id.
      if (!(error instanceof HttpRouteError) || error.status !== 404) throw error;
    }
    forgetRewardLocalState(rewardId);
    response.status(204).send();
  }));
}
