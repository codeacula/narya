using MediatR;

using Microsoft.AspNetCore.Mvc;

using Narya.Application.Chat;

namespace Narya.Api.Controllers;

/// <summary>
/// <c>GET /api/chat/recent</c> is on the overlay token's read allowlist (see
/// <c>Narya.Api.Auth.DashboardTokenMiddleware.OverlayPaths</c>) — the chat overlay seeds itself
/// from it before <c>chat:message</c> broadcasts start arriving. <c>GET /api/chat/events/recent</c>
/// is operator-only; it exposes raw event payloads (including moderation reasons), not a shape
/// meant for a browser-source overlay.
/// </summary>
[ApiController]
[Route("api/chat")]
public sealed class ChatController(IMediator mediator) : ControllerBase
{
  [HttpGet("recent")]
  public async Task<IActionResult> GetRecent(CancellationToken cancellationToken)
  {
    var messages = await mediator.Send(new GetRecentChatMessagesQuery(), cancellationToken).ConfigureAwait(false);
    return Ok(messages);
  }

  [HttpGet("events/recent")]
  public async Task<IActionResult> GetRecentEvents(CancellationToken cancellationToken)
  {
    var events = await mediator.Send(new GetRecentChatEventsQuery(), cancellationToken).ConfigureAwait(false);
    return Ok(events);
  }
}
