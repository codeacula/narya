namespace Narya.Twitch.Tokens;

/// <summary>
/// The secret half of one provider's stored OAuth token: a PLAIN Marten document (not a
/// snapshot projection, not an event stream) written with <c>session.Store</c> overwrite
/// semantics and hard-deleted on disconnect, keyed by the same
/// <see cref="TwitchTokenStore.StreamIdFor"/> per-provider Guid as
/// <see cref="DbTwitchToken"/> so the two halves always join.
///
/// <para>
/// This exists because an event stream is append-only and
/// <c>TwitchCredentials.RefreshAndSaveAsync</c> saves on every token refresh — carrying
/// these values as event data accumulated one full plaintext credential set per refresh
/// that neither rotation nor disconnect could erase. Legacy hard-deleted the
/// <c>twitch_oauth</c> row on disconnect (<c>legacy/src/server/twitch/auth.ts</c>);
/// overwrite-in-place plus a real delete here restores that erasure semantic. The
/// non-secret metadata (scopes, token type, expiry) stays event-sourced in
/// <see cref="DbTwitchToken"/>.
/// </para>
/// </summary>
public sealed record DbTwitchTokenSecrets
{
  /// <summary>
  /// Domain defaults from <see cref="TwitchToken"/>, not bare literals — same rule as the
  /// snapshot projections: this is what a stored document predating a later-added field
  /// deserializes to.
  /// </summary>
  private static readonly TwitchToken DomainDefaults = new();

  public Guid Id { get; init; }

  public string AccessToken { get; init; } = DomainDefaults.AccessToken;
  public string? RefreshToken { get; init; } = DomainDefaults.RefreshToken;
}
