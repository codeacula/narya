using DomainConfig = Narya.Domain.AppConfig.AppConfig;

namespace Narya.Core.AppConfig;

/// <summary>
/// The client-safe shape of <see cref="DomainConfig"/>. Secret values
/// (<c>TwitchClientSecret</c>, <c>ObsPassword</c>, <c>DiscordBotToken</c>) never leave the
/// server: each is exposed only as a <c>*Configured</c> boolean, mirroring the legacy
/// Bun app's <c>getAppConfig()</c> masking. Construct via <see cref="From"/> rather than
/// the object initializer directly, so the masking rule lives in exactly one place.
/// </summary>
public sealed record AppConfigResponse
{
  public string TwitchChannel { get; init; } = "";
  public string TwitchClientId { get; init; } = "";
  public bool TwitchClientSecretConfigured { get; init; }
  public string ObsUrl { get; init; } = "";
  public bool ObsPasswordConfigured { get; init; }
  public string ObsScenePrefix { get; init; } = "";
  public string DiscordClientId { get; init; } = "";
  public bool DiscordBotTokenConfigured { get; init; }
  public string ChatterboxBaseUrl { get; init; } = "";
  public int MusicPollIntervalMs { get; init; }
  public string MusicPlayerctlPlayer { get; init; } = "";
  public double SoundVolume { get; init; }

  /// <summary>
  /// When this configuration was last updated. Null when no update has ever been
  /// persisted.
  /// </summary>
  public DateTimeOffset? UpdatedAt { get; init; }

  public static AppConfigResponse From(DomainConfig config) => new()
  {
    TwitchChannel = config.TwitchChannel,
    TwitchClientId = config.TwitchClientId,
    TwitchClientSecretConfigured = config.TwitchClientSecret != "",
    ObsUrl = config.ObsUrl,
    ObsPasswordConfigured = config.ObsPassword != "",
    ObsScenePrefix = config.ObsScenePrefix,
    DiscordClientId = config.DiscordClientId,
    DiscordBotTokenConfigured = config.DiscordBotToken != "",
    ChatterboxBaseUrl = config.ChatterboxBaseUrl,
    MusicPollIntervalMs = config.MusicPollIntervalMs,
    MusicPlayerctlPlayer = config.MusicPlayerctlPlayer,
    SoundVolume = config.SoundVolume,
    UpdatedAt = config.UpdatedAt,
  };
}
