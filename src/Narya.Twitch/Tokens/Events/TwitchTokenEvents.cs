using Narya.Database.Common;

namespace Narya.Twitch.Tokens.Events;

/// <summary>
/// A full replacement of one provider's stored token. Unlike
/// <c>AppConfigUpdatedEvent</c>, no field is optional-for-unchanged — a token save always
/// supersedes whatever was stored before, so every <see cref="TwitchToken"/> field is
/// carried on every event rather than folded against the previous projection.
/// </summary>
public sealed record TwitchTokenUpdatedEvent : INaryaEvent
{
  public const int SchemaVersion = 1;

  public required Guid EventId { get; init; }

  public required DateTimeOffset OccurredAt { get; init; }

  public required string AccessToken { get; init; }
  public string? RefreshToken { get; init; }
  public required IReadOnlyList<string> Scopes { get; init; }
  public string? TokenType { get; init; }
  public DateTimeOffset? ExpiresAt { get; init; }
}

/// <summary>
/// A sign-out / disconnect for one provider. Appended to the existing stream rather than
/// deleting it — <c>DbTwitchToken</c> folds this to a tombstoned state so
/// <c>TwitchTokenStore.GetAsync</c> reads it back as absent, while the stream itself (and
/// the history of when the account was connected/disconnected) stays inspectable.
/// </summary>
public sealed record TwitchTokenClearedEvent : INaryaEvent
{
  public const int SchemaVersion = 1;

  public required Guid EventId { get; init; }

  public required DateTimeOffset OccurredAt { get; init; }
}
