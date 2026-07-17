// Mirrors Narya.Core.AppConfig.AppConfigResponse / AppConfigPatch (see
// src/Narya.Core/AppConfig/AppConfigResponse.cs and AppConfigPatch.cs). Secret
// fields (TwitchClientSecret, ObsPassword, DiscordBotToken) never reach the
// client — each is exposed only as a `*Configured` boolean.
export interface AppConfigResponse {
  twitchChannel: string
  twitchClientId: string
  twitchClientSecretConfigured: boolean
  obsUrl: string
  obsPasswordConfigured: boolean
  obsScenePrefix: string
  discordClientId: string
  discordBotTokenConfigured: boolean
  chatterboxBaseUrl: string
  musicPollIntervalMs: number
  musicPlayerctlPlayer: string
  soundVolume: number
  updatedAt: string | null
}

// Mirrors AppConfigPatch: every field is optional ("leave unchanged" when
// omitted/undefined). Secret fields here are the plaintext value to set — an
// empty string clears it — never the *Configured booleans, which are
// server-computed and read-only.
export interface AppConfigPatch {
  twitchChannel?: string
  twitchClientId?: string
  twitchClientSecret?: string
  obsUrl?: string
  obsPassword?: string
  obsScenePrefix?: string
  discordClientId?: string
  discordBotToken?: string
  chatterboxBaseUrl?: string
  musicPollIntervalMs?: number
  musicPlayerctlPlayer?: string
  soundVolume?: number
}

export interface HealthResponse {
  ok: boolean
}
