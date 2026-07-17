using Narya.Api.Auth;

namespace Narya.Api.Tests.Auth;

public sealed class OverlayTokenTests
{
  /// <summary>
  /// Ground-truth vectors computed from the legacy Node implementation
  /// (crypto.createHmac('sha256', DASHBOARD_TOKEN).update('narya:overlay:v1'))
  /// and cross-checked with openssl. Do not "fix" these values — if the
  /// implementation disagrees with them, the implementation is wrong.
  /// </summary>
  [Theory]
  [InlineData("op-token", "3b92ec3d8dfd1b95433a02b5e8f3633d")]
  [InlineData("dev-token", "2fbd76cf8370132dc4eb78bd252be8ec")]
  public void DeriveMatchesLegacyGroundTruthVector(string dashboardToken, string expected)
  {
    Assert.Equal(expected, OverlayToken.Derive(dashboardToken));
  }
}
