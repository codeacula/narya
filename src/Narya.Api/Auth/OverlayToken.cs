using System.Security.Cryptography;
using System.Text;

namespace Narya.Api.Auth;

/// <summary>
/// Derives the overlay (read-only) token from the operator's dashboard token.
///
/// Derived rather than separately configured so the operator has exactly one
/// secret to manage — rotating the dashboard token rotates the overlay token
/// with it. This MUST stay byte-identical to the legacy Node implementation
/// (<c>legacy/src/server/auth.ts</c>, <c>getOverlayToken</c>):
///
///   crypto.createHmac('sha256', DASHBOARD_TOKEN).update('narya:overlay:v1').digest('hex').slice(0, 32)
///
/// An OBS browser source URL carrying this token is a long-lived, plainly
/// visible credential baked into someone's live scene collection — changing
/// the derivation here would silently invalidate every operator's existing
/// overlay setup.
/// </summary>
public static class OverlayToken
{
  private const string DerivationMessage = "narya:overlay:v1";

  public static string Derive(string dashboardToken)
  {
    using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(dashboardToken));
    var hash = hmac.ComputeHash(Encoding.UTF8.GetBytes(DerivationMessage));
    return Convert.ToHexStringLower(hash)[..32];
  }
}
