namespace Narya.Domain.AppConfig;

/// <summary>
/// The runtime configuration aggregate: Twitch/OBS/Discord/Chatterbox credentials, the
/// music poller, and sound volume. Defaults mirror the legacy Bun app's
/// <c>legacy/src/server/appConfig.ts</c> <c>DEFAULTS</c> exactly, so a fresh
/// <see cref="AppConfig"/> is what a brand-new install starts with before the operator
/// opens Settings.
/// </summary>
public sealed record AppConfig
{
  public string TwitchChannel { get; init; } = "";
  public string TwitchClientId { get; init; } = "";
  public string TwitchClientSecret { get; init; } = "";
  public string ObsUrl { get; init; } = "ws://127.0.0.1:4455";
  public string ObsPassword { get; init; } = "";
  public string ObsScenePrefix { get; init; } = "Scene - ";
  public string DiscordClientId { get; init; } = "";
  public string DiscordBotToken { get; init; } = "";
  public string ChatterboxBaseUrl { get; init; } = "http://127.0.0.1:8008";
  public int MusicPollIntervalMs { get; init; } = 2000;
  public string MusicPlayerctlPlayer { get; init; } = "strawberry";
  public double SoundVolume { get; init; } = 0.2;

  /// <summary>
  /// When this configuration was last updated, projected from the most recent applied
  /// event's <c>OccurredAt</c>. Null when no update has ever been persisted. Not
  /// patchable — it is derived, not stored input.
  /// </summary>
  public DateTimeOffset? UpdatedAt { get; init; }
}
