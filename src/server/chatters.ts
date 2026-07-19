import type { Express } from 'express';
import type { ChattersResponse } from '../shared/api';
import { handle } from './http';
import type { RuntimeState } from './runtime';
import { getTwitchActionCredentials, twitchFetch } from './twitch/api';
import {
  loginsMissingProfile,
  recordChatterPresence,
  saveChatterProfile,
  type ChatterPresence,
} from './viewerIdentity';

const HELIX = 'https://api.twitch.tv/helix';
const CHATTERS_SCOPE = 'moderator:read:chatters';
/** Helix caps Get Chatters per page and Get Users per request. */
const CHATTERS_PAGE = 1000;
const USERS_BATCH = 100;
/** A very large channel must not turn one poll into hundreds of Helix calls. */
const MAX_CHATTER_PAGES = 10;

type TwitchChattersData = {
  data?: Array<{ user_id: string; user_login: string; user_name: string }>;
  total?: number;
  pagination?: { cursor?: string };
};

type TwitchUsersData = {
  data?: Array<{
    id: string;
    login: string;
    display_name: string;
    profile_image_url: string;
    created_at: string;
  }>;
};

type Credentials = Awaited<ReturnType<typeof getTwitchActionCredentials>>;

/**
 * The Helix call, as a port.
 *
 * Injected rather than imported directly so the pagination loop and the
 * asked-for-but-not-returned branch can be exercised without a live Twitch
 * connection — both are logic a viewer roster depends on, and neither is
 * reachable from a test otherwise.
 */
export type TwitchFetcher = typeof twitchFetch;

/**
 * Every chatter Helix will give us, following the pagination cursor.
 *
 * The previous version requested one page and dropped the cursor it had already
 * typed, so a channel with more than 1000 present accounts silently lost the rest.
 * Capped at MAX_CHATTER_PAGES, and hitting the cap is logged rather than passed off
 * as a complete list — truncation that reads like completeness is the worse failure.
 */
export async function fetchAllChatters(
  credentials: Credentials,
  fetcher: TwitchFetcher = twitchFetch,
): Promise<{ chatters: ChatterPresence[]; total: number; truncated: boolean }> {
  const chatters: ChatterPresence[] = [];
  let cursor: string | undefined;
  let total = 0;
  let pages = 0;

  do {
    const params = new URLSearchParams({
      broadcaster_id: credentials.broadcasterId,
      moderator_id: credentials.broadcasterId,
      first: String(CHATTERS_PAGE),
    });
    if (cursor) params.set('after', cursor);

    const res = await fetcher(`${HELIX}/chat/chatters?${params.toString()}`, {
      credentials,
      errorMessage: 'Twitch chatters request failed.',
    });
    const data = await res.json() as TwitchChattersData;

    for (const entry of data.data ?? []) {
      chatters.push({ userId: entry.user_id, userLogin: entry.user_login, userName: entry.user_name });
    }
    if (typeof data.total === 'number') total = data.total;
    cursor = data.pagination?.cursor || undefined;
    pages += 1;
  } while (cursor && pages < MAX_CHATTER_PAGES);

  const truncated = Boolean(cursor);
  if (truncated) {
    console.warn(
      `chatters: stopped after ${pages} pages (${chatters.length} of ${total}); ` +
      'the remaining chatters were not recorded this poll.',
    );
  }

  return { chatters, total: total || chatters.length, truncated };
}

/**
 * Fill in display name, avatar, and account age for logins never resolved before.
 *
 * Lazy by design: this rides the presence poll the dashboard already makes, touches
 * only rows still missing a profile, and does at most one Helix batch per call. A
 * login Twitch does not return is marked rather than retried forever, so one deleted
 * account cannot make every future poll re-request it.
 */
export async function backfillProfiles(
  credentials: Credentials,
  fetcher: TwitchFetcher = twitchFetch,
): Promise<{ resolved: number; missing: number }> {
  const logins = loginsMissingProfile(USERS_BATCH);
  if (logins.length === 0) return { resolved: 0, missing: 0 };

  const params = new URLSearchParams();
  for (const login of logins) params.append('login', login);

  const res = await fetcher(`${HELIX}/users?${params.toString()}`, {
    credentials,
    errorMessage: 'Twitch user lookup failed.',
  });
  const data = await res.json() as TwitchUsersData;

  const returned = new Set<string>();
  for (const user of data.data ?? []) {
    returned.add(user.login.toLowerCase());
    saveChatterProfile({
      login: user.login,
      userId: user.id,
      displayName: user.display_name,
      profileImageUrl: user.profile_image_url,
      accountCreatedAt: user.created_at,
    });
  }

  // Asked for but not returned: renamed, deleted, or banned. Marked rather than
  // retried, so one dead account cannot make every future poll re-request it.
  let missing = 0;
  for (const login of logins) {
    if (returned.has(login.toLowerCase())) continue;
    saveChatterProfile({ login, missing: true });
    missing += 1;
  }

  return { resolved: returned.size, missing };
}

export function registerChattersRoutes(app: Express, state: RuntimeState) {
  app.get('/api/chatters', handle(async (_req, res) => {
    const credentials = await getTwitchActionCredentials(state, [CHATTERS_SCOPE]);
    const { chatters, total } = await fetchAllChatters(credentials);

    // Presence first, so a lurker exists as a row even if the profile fetch fails.
    recordChatterPresence(chatters);
    try {
      await backfillProfiles(credentials);
    } catch (error: unknown) {
      // A failed backfill must not fail the poll: the roster is still correct without
      // avatars, and `profile_fetched_at` stays null so the next poll retries.
      console.warn('chatters: profile backfill failed:', error);
    }

    const response: ChattersResponse = { chatters, total };
    res.json(response);
  }));
}
