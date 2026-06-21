export const config = {
  port: Number(process.env.PORT ?? 4317),
  twitchChannel: process.env.TWITCH_CHANNEL ?? 'codeacula',
  obsUrl: process.env.OBS_WEBSOCKET_URL ?? 'ws://127.0.0.1:4455',
  obsPassword: process.env.OBS_WEBSOCKET_PASSWORD ?? '',
  musicPollIntervalMs: Number(process.env.MUSIC_POLL_INTERVAL_MS ?? 2000),
  musicPlayerctlPlayer: process.env.MUSIC_PLAYERCTL_PLAYER?.trim() || 'strawberry',
  quackVolume: Math.max(0, Math.min(1, Number(process.env.QUACK_VOLUME ?? 0.2))),
  quackSounds: [
    '/sounds/quacks/075176_duck-quack-40345.mp3',
    '/sounds/quacks/duck-quack-112941.mp3',
    '/sounds/quacks/duck-quacking-37392.mp3',
  ],
  twitchRedirectUri: process.env.TWITCH_REDIRECT_URI ?? 'http://localhost:5173/api/auth/twitch/callback',
};
