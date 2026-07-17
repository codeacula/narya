using JasperFx.Events;

using Narya.Twitch.Tokens.Events;

namespace Narya.Twitch.Tokens;

/// <summary>
/// Marten self-aggregating inline snapshot for a single provider's token stream — one
/// stream per <see cref="TwitchProvider"/>, each keyed by <c>TwitchTokenStore</c>'s fixed
/// per-provider Guid, mirroring <c>DbAppConfig</c>'s singleton-stream pattern one level
/// down (per-provider instead of per-deployment). Marten discovers <see cref="Create"/>
/// and <see cref="Apply"/> by convention (see <c>NaryaTwitchMartenConfig.Configure</c>'s
/// <c>Projections.Snapshot&lt;DbTwitchToken&gt;</c> registration) and must be public — a
/// non-public document type fails Marten's storage codegen at runtime.
/// </summary>
public sealed record DbTwitchToken
{
  public Guid Id { get; init; }

  /// <summary>
  /// Set by <see cref="Apply(IEvent{TwitchTokenClearedEvent}, DbTwitchToken)"/>. A
  /// tombstoned projection still exists as a Marten document (the stream is never
  /// hard-deleted) but reads back as an absent token via the explicit operator below.
  /// </summary>
  public bool IsCleared { get; init; }

  public string AccessToken { get; init; } = "";
  public string? RefreshToken { get; init; }
  public IReadOnlyList<string> Scopes { get; init; } = [];
  public string? TokenType { get; init; }
  public DateTimeOffset? ExpiresAt { get; init; }
  public DateTimeOffset? UpdatedAt { get; init; }

  public static DbTwitchToken Create(IEvent<TwitchTokenUpdatedEvent> ev) => Apply(ev, new DbTwitchToken());

  public static DbTwitchToken Apply(IEvent<TwitchTokenUpdatedEvent> ev, DbTwitchToken current) => current with
  {
    IsCleared = false,
    AccessToken = ev.Data.AccessToken,
    RefreshToken = ev.Data.RefreshToken,
    Scopes = ev.Data.Scopes,
    TokenType = ev.Data.TokenType,
    ExpiresAt = ev.Data.ExpiresAt,
    UpdatedAt = ev.Data.OccurredAt,
  };

  public static DbTwitchToken Apply(IEvent<TwitchTokenClearedEvent> ev, DbTwitchToken current) => current with
  {
    IsCleared = true,
    AccessToken = "",
    RefreshToken = null,
    Scopes = [],
    TokenType = null,
    ExpiresAt = null,
    UpdatedAt = ev.Data.OccurredAt,
  };

  /// <summary>
  /// Returns null when tombstoned, so a cleared token round-trips through
  /// <c>TwitchTokenStore.GetAsync</c> exactly like a provider that was never connected.
  /// </summary>
  public static explicit operator TwitchToken?(DbTwitchToken db)
  {
    return db.IsCleared
      ? null
      : new TwitchToken
      {
        AccessToken = db.AccessToken,
        RefreshToken = db.RefreshToken,
        Scopes = db.Scopes,
        TokenType = db.TokenType,
        ExpiresAt = db.ExpiresAt,
      };
  }
}
