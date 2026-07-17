using Narya.Database.Common;

namespace Narya.Database.AppConfig.Events;

/// <summary>
/// A partial update to the singleton <c>AppConfig</c> root stream. Every config field is
/// nullable: null means "this event did not change this field", not "clear it" — the
/// projection folds each field with <c>ev.Data.X ?? current.X</c>. An explicit empty
/// string is a real, non-null value and clears the field.
/// </summary>
public sealed record AppConfigUpdatedEvent : INaryaEvent
{
  public const int SchemaVersion = 1;

  public required Guid EventId { get; init; }

  public required DateTimeOffset OccurredAt { get; init; }

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
