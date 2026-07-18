using Narya.Database.Common;

namespace Narya.Database.AppConfig.Events;

/// <summary>
/// A partial update to the singleton <c>AppConfig</c> root stream. Every config field is
/// nullable: null means "this event did not change this field", not "clear it" — the
/// projection folds each field with <c>ev.Data.X ?? current.X</c>. An explicit empty
/// string is a real, non-null value and clears the field.
///
/// <para>
/// Schema v1 carried the secret values (<c>TwitchClientSecret</c>, <c>ObsPassword</c>,
/// <c>DiscordBotToken</c>) inline. v2 does NOT: an event stream is append-only, so a
/// secret written as event data stays readable forever and rotating it cannot erase the
/// old value. The secret VALUES now live in <c>DbAppConfigSecrets</c>, a plain
/// Marten document written with overwrite semantics by <c>AppConfigStore</c> in the same
/// transaction as this event. The audit trail of WHEN a secret changed survives here (the
/// event is still appended); only the value moved.
/// </para>
/// </summary>
public sealed record AppConfigUpdatedEvent : INaryaEvent
{
  public const int SchemaVersion = 2;

  public required Guid EventId { get; init; }

  public required DateTimeOffset OccurredAt { get; init; }

  public string? TwitchChannel { get; init; }
  public string? TwitchClientId { get; init; }
  public string? ObsUrl { get; init; }
  public string? ObsScenePrefix { get; init; }
  public string? DiscordClientId { get; init; }
  public string? ChatterboxBaseUrl { get; init; }
  public int? MusicPollIntervalMs { get; init; }
  public string? MusicPlayerctlPlayer { get; init; }
  public double? SoundVolume { get; init; }
}
