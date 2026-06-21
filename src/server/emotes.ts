let emoteCacheTime = 0;
let emoteCache: Record<string, string> = {};
const EMOTE_CACHE_TTL = 10 * 60 * 1000;

export async function getEmoteMap(twitchRoomId: string | null): Promise<Record<string, string>> {
  const now = Date.now();
  if (now - emoteCacheTime < EMOTE_CACHE_TTL && Object.keys(emoteCache).length > 0) {
    return emoteCache;
  }

  const map: Record<string, string> = {};

  try {
    const bttvGlobal = await fetch('https://api.betterttv.net/3/cached/emotes/global').then(
      (r) => r.json() as Promise<Array<{ code: string; id: string }>>,
    );
    for (const emote of bttvGlobal) {
      map[emote.code] = `https://cdn.betterttv.net/emote/${emote.id}/1x`;
    }
  } catch (error) {
    console.error('Emotes: failed to fetch global BTTV emotes:', error);
  }

  try {
    const stv = await fetch('https://7tv.io/v3/emote-sets/global').then(
      (r) => r.json() as Promise<{ emotes: Array<{ id: string; name: string }> }>,
    );
    for (const emote of stv.emotes ?? []) {
      map[emote.name] = `https://cdn.7tv.app/emote/${emote.id}/1x.webp`;
    }
  } catch (error) {
    console.error('Emotes: failed to fetch global 7TV emotes:', error);
  }

  if (twitchRoomId) {
    try {
      const bttvChannel = await fetch(
        `https://api.betterttv.net/3/cached/users/twitch/${twitchRoomId}`,
      ).then(
        (r) =>
          r.json() as Promise<{
            channelEmotes: Array<{ code: string; id: string }>;
            sharedEmotes: Array<{ code: string; id: string }>;
          }>,
      );
      for (const emote of [...(bttvChannel.channelEmotes ?? []), ...(bttvChannel.sharedEmotes ?? [])]) {
        map[emote.code] = `https://cdn.betterttv.net/emote/${emote.id}/1x`;
      }
    } catch (error) {
      console.error(`Emotes: failed to fetch BTTV channel emotes for ${twitchRoomId}:`, error);
    }

    try {
      const stv7 = await fetch(`https://7tv.io/v3/users/twitch/${twitchRoomId}`).then(
        (r) =>
          r.json() as Promise<{
            emote_set?: { emotes: Array<{ id: string; name: string }> };
          }>,
      );
      for (const emote of stv7.emote_set?.emotes ?? []) {
        map[emote.name] = `https://cdn.7tv.app/emote/${emote.id}/1x.webp`;
      }
    } catch (error) {
      console.error(`Emotes: failed to fetch 7TV channel emotes for ${twitchRoomId}:`, error);
    }
  }

  emoteCache = map;
  emoteCacheTime = now;
  return emoteCache;
}
