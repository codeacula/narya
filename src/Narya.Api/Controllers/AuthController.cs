using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;

using Narya.Api.Auth;

namespace Narya.Api.Controllers;

[ApiController]
[Route("api/auth")]
public sealed class AuthController(IOptions<NaryaAuthOptions> options) : ControllerBase
{
  private readonly NaryaAuthOptions _options = options.Value;

  /// <summary>
  /// Deliberately NOT on <see cref="DashboardTokenMiddleware.OverlayPaths"/>, so the
  /// middleware already rejects an overlay-token caller with 403 before this action
  /// runs. The role check below is defense-in-depth against that allowlist ever
  /// growing to include this route by mistake — an overlay must never be able to
  /// read the URL an OBS browser source would need query-string driven back to itself.
  /// </summary>
  [HttpGet("overlay-token")]
  public IActionResult GetOverlayToken()
  {
    var role = HttpContext.Items.TryGetValue(DashboardTokenMiddleware.RoleItemKey, out var value) ? value as string : null;
    if (role != DashboardTokenMiddleware.OperatorRole)
    {
      return StatusCode(StatusCodes.Status403Forbidden, new { error = "Forbidden: operator only" });
    }

    return string.IsNullOrEmpty(_options.DashboardToken)
      ? NotFound()
      : Ok(new { token = OverlayToken.Derive(_options.DashboardToken) });
  }
}
