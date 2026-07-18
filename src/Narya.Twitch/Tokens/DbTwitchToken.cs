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

  /// <summary>
  /// Non-secret metadata only. The access/refresh tokens deliberately do NOT live here or
  /// on <see cref="TwitchTokenUpdatedEvent"/> — see <c>DbTwitchTokenSecrets</c>.
  /// </summary>
  public IReadOnlyList<string> Scopes { get; init; } = [];
  public string? TokenType { get; init; }
  public DateTimeOffset? ExpiresAt { get; init; }
  public DateTimeOffset? UpdatedAt { get; init; }

  public static DbTwitchToken Create(IEvent<TwitchTokenUpdatedEvent> ev) => Apply(ev, new DbTwitchToken());

  public static DbTwitchToken Apply(IEvent<TwitchTokenUpdatedEvent> ev, DbTwitchToken current) => current with
  {
    IsCleared = false,
    Scopes = ev.Data.Scopes,
    TokenType = ev.Data.TokenType,
    ExpiresAt = ev.Data.ExpiresAt,
    UpdatedAt = ev.Data.OccurredAt,
  };

  public static DbTwitchToken Apply(IEvent<TwitchTokenClearedEvent> ev, DbTwitchToken current) => current with
  {
    IsCleared = true,
    Scopes = [],
    TokenType = null,
    ExpiresAt = null,
    UpdatedAt = ev.Data.OccurredAt,
  };

  /// <summary>
  /// Composes this event-sourced metadata half with the overwrite-in-place secret half
  /// into the single domain record callers see. Returns null when tombstoned, so a cleared
  /// token round-trips through <c>TwitchTokenStore.GetAsync</c> exactly like a provider
  /// that was never connected. A null <paramref name="secrets"/> — the document was
  /// deleted on disconnect, or never written — yields the domain defaults (empty access
  /// token, null refresh token) rather than throwing. Replaces the former
  /// <c>explicit operator</c>, which could not express the second input.
  /// </summary>
  public TwitchToken? ToDomain(DbTwitchTokenSecrets? secrets)
  {
    if (IsCleared)
    {
      return null;
    }

    var s = secrets ?? new DbTwitchTokenSecrets();

    return new TwitchToken
    {
      AccessToken = s.AccessToken,
      RefreshToken = s.RefreshToken,
      Scopes = Scopes,
      TokenType = TokenType,
      ExpiresAt = ExpiresAt,
    };
  }
}
