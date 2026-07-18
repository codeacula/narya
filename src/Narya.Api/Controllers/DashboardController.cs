using MediatR;

using Microsoft.AspNetCore.Mvc;

using Narya.Application.Events;

namespace Narya.Api.Controllers;

/// <summary>
/// <c>GET /api/dashboard/events</c> is operator-only — deliberately NOT on
/// <c>Narya.Api.Auth.DashboardTokenMiddleware.OverlayPaths</c>. Unlike <c>GET /api/chat/recent</c>
/// (which the chat overlay needs to seed itself before <c>chat:message</c> broadcasts start
/// arriving), nothing under <c>/overlay</c> reads this route: the shoutout ticker instead reads
/// <c>GET /api/dashboard/session-shoutouts</c> (a later task) and the live
/// <c>stream:event</c>/<c>stream:event:update</c> broadcasts, both already overlay-allowlisted
/// (see <c>Narya.Core.Realtime.RealtimeEventNames.OverlayAllowlist</c>).
/// </summary>
[ApiController]
[Route("api/dashboard")]
public sealed class DashboardController(IMediator mediator) : ControllerBase
{
  [HttpGet("events")]
  public async Task<IActionResult> GetEvents(CancellationToken cancellationToken)
  {
    var events = await mediator.Send(new GetRecentStreamEventsQuery(), cancellationToken).ConfigureAwait(false);
    return Ok(events);
  }
}
