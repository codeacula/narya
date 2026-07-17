namespace Narya.Twitch.Tokens;

/// <summary>
/// Everything a Helix call made on the operator's behalf needs: the app's Client-Id header,
/// a fresh broadcaster access token, and the broadcaster's own user id (many Helix endpoints
/// take it as a query/body parameter). Returned by
/// <see cref="ITwitchCredentials.GetActionCredentialsAsync"/> so a single call resolves and
/// validates everything a Helix request needs instead of three separate round trips.
/// </summary>
public sealed record TwitchActionCredentials
{
  public required string ClientId { get; init; }
  public required string AccessToken { get; init; }
  public required string BroadcasterId { get; init; }
}
