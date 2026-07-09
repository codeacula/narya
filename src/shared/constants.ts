export const TOKEN_EXPIRY_REFRESH_BUFFER_MS = 60_000;

export const EVENTSUB_DEFAULT_KEEPALIVE_MS = 20_000;
export const EVENTSUB_STALE_SOCKET_CLOSE_MS = 30_000;
export const EVENTSUB_RECONNECT_DELAY_MS = 10_000;

/**
 * Event kinds worth thanking someone for. `ad_break` is deliberately absent —
 * nobody thanks an ad. Shared so the shoutout query and the attention feed can
 * never disagree about what belongs on the public ticker.
 */
export const THANK_WORTHY_EVENT_KINDS = ['follow', 'sub', 'gift', 'cheer', 'raid', 'redeem'] as const;

export const DASHBOARD_FULL_REFRESH_MS = 30_000;
export const DASHBOARD_STATUS_REFRESH_MS = 5_000;
export const DASHBOARD_HEARTBEAT_MS = 5_000;
export const DASHBOARD_RECENT_VIEWER_MESSAGE_LIMIT = 500;

export const TWITCH_STREAM_STATUS_CACHE_MS = 15_000;
export const TWITCH_AD_SCHEDULE_CACHE_MS = 5_000;

export const OVERLAY_CHAT_EXPIRE_MS = 14_000;
export const OVERLAY_CHAT_FADE_MS = 450;

// Delay after a suggestion input blurs before hiding its dropdown, so a click on an option still registers.
export const SUGGESTION_DISMISS_MS = 150;
