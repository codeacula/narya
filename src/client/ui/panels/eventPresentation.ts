import { loadStoredJson, saveStoredJson } from '../../storage';

/* follow/sub/raid/cheer use the overlay alert cards' glyphs. */
export const EVT_ICON: Record<string, string> = {
  follow: 'sparkle',
  sub: 'planet',
  gift: 'gift',
  cheer: 'gem',
  raid: 'raid',
  redeem: 'star',
  ad_break: 'play',
  chat: 'chat',
};

export const EVT_KIND_LABEL: Record<string, string> = {
  follow: 'Follows',
  sub: 'Subs',
  gift: 'Gifts',
  cheer: 'Cheers',
  raid: 'Raids',
  redeem: 'Redeems',
  ad_break: 'Ad Breaks',
};

const EVT_FILTER_KEY = 'eventFeedHiddenKinds';
const EVT_DEFAULT_HIDDEN = new Set(['ad_break']);

export function loadHiddenKinds(): Set<string> {
  return loadStoredJson(EVT_FILTER_KEY, raw => new Set(raw as string[]), () => new Set(EVT_DEFAULT_HIDDEN));
}

export function saveHiddenKinds(hidden: Set<string>): void {
  saveStoredJson(EVT_FILTER_KEY, [...hidden]);
}
