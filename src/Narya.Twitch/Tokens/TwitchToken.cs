namespace Narya.Twitch.Tokens;

/// <summary>
/// The domain shape of a stored OAuth token for one <see cref="TwitchProvider"/>. A save
/// always replaces the whole record — there is no partial-token update — so every field
/// here maps 1:1 onto <c>TwitchTokenUpdatedEvent</c>.
/// </summary>
public sealed record TwitchToken
{
  public string AccessToken { get; init; } = "";
  public string? RefreshToken { get; init; }
  public IReadOnlyList<string> Scopes { get; init; } = [];
  public string? TokenType { get; init; }
  public DateTimeOffset? ExpiresAt { get; init; }
}
