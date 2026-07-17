namespace Narya.Core.AppConfig;

/// <summary>
/// A partial update to <see cref="Narya.Domain.AppConfig.AppConfig"/>. Every field is
/// nullable with "null = leave unchanged" semantics. A non-null value — including an
/// empty string — means "set to this value", so patching a secret field to <c>""</c>
/// clears it. This replaces legacy's separate <c>clear*</c> booleans with a single,
/// unambiguous convention for the new client.
/// </summary>
public sealed record AppConfigPatch
{
  public string? TwitchChannel { get; init; }
  public string? TwitchClientId { get; init; }
  public string? TwitchClientSecret { get; init; }
  public string? ObsUrl { get; init; }
  public string? ObsPassword { get; init; }
  public string? ObsScenePrefix { get; init; }
  public string? DiscordClientId { get; init; }
  public string? DiscordBotToken { get; init; }
  public string? ChatterboxBaseUrl { get; init; }
  public int? MusicPollIntervalMs { get; init; }
  public string? MusicPlayerctlPlayer { get; init; }
  public double? SoundVolume { get; init; }
}
