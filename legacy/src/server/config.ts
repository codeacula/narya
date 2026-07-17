/**
 * Boot/infrastructure config only — every value here is read on every boot and
 * genuinely cannot come from the database.
 *
 * Everything else (Twitch/OBS/Discord credentials, channel, OBS scene prefix,
 * music, sound volume) is configured from the Settings UI and persisted in the
 * database — see src/server/appConfig.ts. Those settings used to seed themselves
 * from environment variables on first boot; they no longer do, because a variable
 * consulted once and ignored forever reads like live configuration and is not.
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

export const config = {
  // The port must be bound before the database can be read, so it cannot live there.
  port: Number(process.env.PORT ?? 4317),
  // Loopback by default: an unauthenticated API that can ban viewers, drive OBS,
  // and rewrite credentials must not be reachable from the LAN. Set HOST=0.0.0.0
  // to serve the tablet/overlays to other devices — that requires DASHBOARD_TOKEN
  // (enforced at startup in index.ts).
  host: process.env.HOST?.trim() || '127.0.0.1',
  // Operator token: full control over every /api/* route and the WebSocket. The
  // read-only overlay token is derived from it (see auth.ts). Only optional when
  // the server is bound to loopback.
  dashboardToken: process.env.DASHBOARD_TOKEN?.trim() ?? '',
  // OAuth redirect URIs cannot be derived: they must match, character for character,
  // what is registered in the Twitch/Discord developer console. The defaults cover
  // local dev through the Vite proxy; override only if you deploy differently.
  twitchRedirectUri: process.env.TWITCH_REDIRECT_URI ?? 'http://localhost:5173/api/auth/twitch/callback',
  discordRedirectUri: process.env.DISCORD_REDIRECT_URI ?? 'http://localhost:5173/api/auth/discord/callback',
};
