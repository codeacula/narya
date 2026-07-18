namespace Narya.Api.Auth;

/// <summary>Options bound from the <c>Narya</c> configuration section.</summary>
public sealed class NaryaAuthOptions
{
  /// <summary>
  /// The operator's dashboard token. Empty means "no auth configured" — the
  /// middleware then falls back to loopback-only operator access, but ONLY when
  /// <see cref="AllowLoopbackOperatorWithoutToken"/> was explicitly opted into.
  /// </summary>
  public string DashboardToken { get; set; } = string.Empty;

  /// <summary>
  /// Explicit opt-in to the no-token loopback-operator path, for a genuinely local-only run.
  /// Defaults to FALSE so a deployment that sets nothing at all fails closed — it refuses to
  /// start (<see cref="StartupBindingGuard"/>) rather than quietly serving full operator access
  /// to whatever reaches it over loopback, which behind a same-host reverse proxy is the entire
  /// internet. Setting it does NOT relax anything else: the guard still refuses a non-loopback
  /// binding and still refuses a declared <see cref="TrustedProxies"/> allowlist without a token.
  /// </summary>
  public bool AllowLoopbackOperatorWithoutToken { get; set; }

  /// <summary>
  /// The redirect URI registered with the Twitch application, used identically by both the
  /// authorize request and the token-exchange call — Twitch rejects a code exchange whose
  /// <c>redirect_uri</c> does not match the one the authorize step sent. Cannot be derived
  /// (it must match the Twitch app registration exactly), but has a working default for the
  /// dev port so <c>.env</c>/appsettings need not set it for local development.
  /// </summary>
  public string TwitchRedirectUri { get; set; } = "http://localhost:5000/api/auth/twitch/callback";
}
