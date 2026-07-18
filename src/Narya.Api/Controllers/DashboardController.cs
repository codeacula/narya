using MediatR;

using Microsoft.AspNetCore.Mvc;

using Narya.Application.Dashboard;
using Narya.Application.Events;
using Narya.Application.Viewers;
using Narya.Core.Viewers;

namespace Narya.Api.Controllers;

/// <summary>
/// <c>GET /api/dashboard/events</c> is operator-only — deliberately NOT on
/// <c>Narya.Api.Auth.DashboardTokenMiddleware.OverlayPaths</c>. Unlike <c>GET /api/chat/recent</c>
/// (which the chat overlay needs to seed itself before <c>chat:message</c> broadcasts start
/// arriving), nothing under <c>/overlay</c> reads this route: the shoutout ticker instead reads
/// <c>GET /api/dashboard/session-shoutouts</c> (IS overlay-allowlisted — see
/// <see cref="GetSessionShoutouts"/>) and the live <c>stream:event</c>/<c>stream:event:update</c>
/// broadcasts, both already overlay-allowlisted (see
/// <c>Narya.Core.Realtime.RealtimeEventNames.OverlayAllowlist</c>).
///
/// <c>GET /api/dashboard/viewers</c>, <c>PATCH /api/dashboard/viewers/{login}/profile</c> (Phase 3
/// Task 5), and <c>GET /api/dashboard/status</c> (Phase 3 Task 7 — see <see cref="GetStatus"/>)
/// are operator-only for the same reason: neither is read by anything under <c>/overlay</c>, and
/// a profile edit / the full status snapshot (auth token expiry, EventSub error detail) are
/// squarely operator-only. See <c>Narya.Api.Controllers.ViewersController</c> for the sibling
/// <c>/api/viewers/*</c> routes (roster, per-viewer messages) legacy split under a different path
/// prefix.
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

  /// <summary>
  /// Overlay-allowlisted — see <c>Narya.Api.Auth.DashboardTokenMiddleware.OverlayPaths</c>. The
  /// <c>/overlay/shoutouts</c> ticker reads this to seed itself, same rationale as
  /// <c>GET /api/chat/recent</c>.
  /// </summary>
  [HttpGet("session-shoutouts")]
  public async Task<IActionResult> GetSessionShoutouts(CancellationToken cancellationToken)
  {
    var shoutouts = await mediator.Send(new GetSessionShoutoutsQuery(), cancellationToken).ConfigureAwait(false);
    return Ok(shoutouts);
  }

  /// <summary>Operator-only — same REST shape <c>Narya.Api.Dashboard.DashboardHeartbeatService</c> broadcasts as <c>dashboard:status</c>.</summary>
  [HttpGet("status")]
  public async Task<IActionResult> GetStatus(CancellationToken cancellationToken)
  {
    var status = await mediator.Send(new GetDashboardStatusQuery(), cancellationToken).ConfigureAwait(false);
    return Ok(status);
  }

  [HttpGet("viewers")]
  public async Task<IActionResult> GetViewers(CancellationToken cancellationToken)
  {
    var viewers = await mediator.Send(new GetRecentViewersQuery(), cancellationToken).ConfigureAwait(false);
    return Ok(viewers);
  }

  [HttpPatch("viewers/{login}/profile")]
  public async Task<IActionResult> UpdateViewerProfile(
    string login, [FromBody] ViewerProfileUpdateRequest? body, CancellationToken cancellationToken)
  {
    var request = body ?? new ViewerProfileUpdateRequest(null, null, null);
    var result = await mediator.Send(
      new UpdateViewerProfileCommand(login, request.RealName, request.Tags, request.Note), cancellationToken)
      .ConfigureAwait(false);

    return result.IsFailed
      ? BadRequest(new { errors = result.Errors.Select(e => e.Message) })
      : Ok(result.Value);
  }
}
