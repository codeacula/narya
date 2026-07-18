using MediatR;

using Microsoft.AspNetCore.Mvc;

using Narya.Application.Viewers;

namespace Narya.Api.Controllers;

/// <summary>
/// <c>GET /api/viewers/roster</c> and <c>GET /api/viewers/{login}/messages</c> — a port of the
/// legacy routes of the same paths in <c>legacy/src/server/dashboard/status.ts</c> (Phase 3
/// Task 5). Both are operator-only — neither is on
/// <c>Narya.Api.Auth.DashboardTokenMiddleware.OverlayPaths</c> — since nothing under
/// <c>/overlay</c> reads a viewer's full history or roster. See
/// <c>Narya.Api.Controllers.DashboardController</c> for the sibling <c>/api/dashboard/viewers*</c>
/// routes legacy split under a different path prefix.
/// </summary>
[ApiController]
[Route("api/viewers")]
public sealed class ViewersController(IMediator mediator) : ControllerBase
{
  [HttpGet("roster")]
  public async Task<IActionResult> GetRoster(CancellationToken cancellationToken)
  {
    var roster = await mediator.Send(new GetRosterQuery(), cancellationToken).ConfigureAwait(false);
    return Ok(roster);
  }

  [HttpGet("{login}/messages")]
  public async Task<IActionResult> GetMessages(string login, [FromQuery] string? before, CancellationToken cancellationToken)
  {
    if (string.IsNullOrWhiteSpace(login))
    {
      return BadRequest(new { error = "Viewer login is required." });
    }

    var messages = await mediator.Send(new GetViewerMessagesQuery(login, before), cancellationToken).ConfigureAwait(false);
    return Ok(messages);
  }
}
