// Boot/infrastructure config only. Everything else (Twitch/OBS/Discord
// credentials, channel, music + quack settings) is configured from the Settings UI
// and persisted in the database — see src/server/appConfig.ts.
export const config = {
  port: Number(process.env.PORT ?? 4317),
  chatterboxBaseUrl: (process.env.CHATTERBOX_BASE_URL ?? 'http://127.0.0.1:8008').replace(/\/+$/, ''),
  // Static asset paths bundled with the app, not user-configurable.
  quackSounds: [
    '/sounds/quacks/075176_duck-quack-40345.mp3',
    '/sounds/quacks/duck-quack-112941.mp3',
    '/sounds/quacks/duck-quacking-37392.mp3',
  ],
  // OAuth redirect URIs are tied to how the app is deployed, so they stay env-driven.
  twitchRedirectUri: process.env.TWITCH_REDIRECT_URI ?? 'http://localhost:5173/api/auth/twitch/callback',
  discordRedirectUri: process.env.DISCORD_REDIRECT_URI ?? 'http://localhost:5173/api/auth/discord/callback',
};
