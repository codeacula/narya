namespace Narya.Api.Auth;

/// <summary>Options bound from the <c>Narya</c> configuration section.</summary>
public sealed class NaryaAuthOptions
{
  /// <summary>
  /// The operator's dashboard token. Empty means "no auth configured" — the
  /// middleware then falls back to loopback-only operator access.
  /// </summary>
  public string DashboardToken { get; set; } = string.Empty;

  /// <summary>
  /// The redirect URI registered with the Twitch application, used identically by both the
  /// authorize request and the token-exchange call — Twitch rejects a code exchange whose
  /// <c>redirect_uri</c> does not match the one the authorize step sent. Cannot be derived
  /// (it must match the Twitch app registration exactly), but has a working default for the
  /// dev port so <c>.env</c>/appsettings need not set it for local development.
  /// </summary>
  public string TwitchRedirectUri { get; set; } = "http://localhost:5000/api/auth/twitch/callback";
}
