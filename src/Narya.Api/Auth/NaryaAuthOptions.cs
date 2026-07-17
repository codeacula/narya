namespace Narya.Api.Auth;

/// <summary>Options bound from the <c>Narya</c> configuration section.</summary>
public sealed class NaryaAuthOptions
{
  /// <summary>
  /// The operator's dashboard token. Empty means "no auth configured" — the
  /// middleware then falls back to loopback-only operator access.
  /// </summary>
  public string DashboardToken { get; set; } = string.Empty;
}
