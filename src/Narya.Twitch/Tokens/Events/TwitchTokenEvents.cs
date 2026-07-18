using Narya.Database.Common;

namespace Narya.Twitch.Tokens.Events;

/// <summary>
/// A full replacement of one provider's stored token. Unlike
/// <c>AppConfigUpdatedEvent</c>, no field is optional-for-unchanged — a token save always
/// supersedes whatever was stored before, so every <see cref="TwitchToken"/> field is
/// carried on every event rather than folded against the previous projection.
///
/// <para>
/// Schema v1 carried <c>AccessToken</c> and <c>RefreshToken</c> inline. v2 does NOT: an
/// event stream is append-only, and <c>TwitchCredentials.RefreshAndSaveAsync</c> saves on
/// EVERY token refresh, so v1 accumulated one full plaintext credential set per refresh
/// that no rotation or disconnect could erase. The token VALUES now live in
/// <c>DbTwitchTokenSecrets</c>, a plain Marten document written with overwrite semantics
/// (and physically deleted on disconnect) by <c>TwitchTokenStore</c> in the same
/// transaction as this event. <c>Scopes</c>/<c>TokenType</c>/<c>ExpiresAt</c> stay here —
/// they are non-secret metadata whose history is useful.
/// </para>
/// </summary>
public sealed record TwitchTokenUpdatedEvent : INaryaEvent
{
  public const int SchemaVersion = 2;

  public required Guid EventId { get; init; }

  public required DateTimeOffset OccurredAt { get; init; }

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
