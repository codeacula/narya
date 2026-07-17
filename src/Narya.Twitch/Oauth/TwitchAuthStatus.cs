namespace Narya.Twitch.Oauth;

/// <summary>
/// The shape <c>GET /api/auth/twitch/status</c> returns — computed entirely from the stored
/// broadcaster/bot tokens (<see cref="Tokens.ITwitchTokenStore"/>), never a live Twitch call.
/// Deliberately excludes the access/refresh token values themselves: callers get booleans,
/// an expiry, and the names of any required scope the stored token lacks, matching legacy's
/// <c>getTwitchAuthStatus</c> (<c>legacy/src/server/twitch/auth.ts</c>).
/// </summary>
public sealed record TwitchAuthStatus
{
  public required bool TwitchAuthenticated { get; init; }

  public string? TwitchAuthSource { get; init; }

  public DateTimeOffset? TwitchTokenExpiresAt { get; init; }

  public required IReadOnlyList<string> TwitchMissingScopes { get; init; }

  public required bool TwitchBotAuthenticated { get; init; }

  public string? TwitchBotAuthSource { get; init; }

  public DateTimeOffset? TwitchBotTokenExpiresAt { get; init; }

  public required IReadOnlyList<string> TwitchBotMissingScopes { get; init; }
}
