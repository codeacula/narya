using System.Text.Json;

using MediatR;

using Microsoft.AspNetCore.Mvc;

using Narya.Application.Automation;

namespace Narya.Api.Controllers;

/// <summary>
/// <c>GET</c>/<c>PUT /api/automation/media-mute</c> — a port of legacy's
/// <c>registerMediaMuteRoutes</c> (<c>legacy/src/server/mediaMute.ts</c>). Deliberately absent from
/// <see cref="Narya.Api.Auth.DashboardTokenMiddleware.OverlayPaths"/> — operator-only, same
/// rationale as <c>ConfigController</c>: an overlay browser source has no business reading or
/// flipping the master mute switch, only rendering whatever an unmuted Action's steps broadcast.
/// </summary>
[ApiController]
[Route("api/automation/media-mute")]
public sealed class MediaMuteController(IMediator mediator) : ControllerBase
{
  [HttpGet]
  public async Task<IActionResult> Get(CancellationToken cancellationToken)
  {
    var result = await mediator.Send(new GetMediaMuteQuery(), cancellationToken).ConfigureAwait(false);
    return Ok(result);
  }

  /// <summary>
  /// Strict legacy-parity coercion: only a literal JSON <c>true</c> for <c>body.muted</c> mutes;
  /// anything else — a string <c>"true"</c>, a number <c>1</c>, an absent field, a missing/empty
  /// body — coerces to <see langword="false"/>, matching legacy's
  /// <c>(request.body as {muted?: unknown})?.muted === true</c>. Bound as a raw
  /// <see cref="JsonElement"/> rather than a typed <c>bool?</c> DTO precisely so a non-boolean
  /// <c>muted</c> value coerces instead of failing model binding with a 400 — a malformed body must
  /// unmute, never silently mute AND never reject the request outright.
  /// </summary>
  [HttpPut]
  public async Task<IActionResult> Put([FromBody] JsonElement? body, CancellationToken cancellationToken)
  {
    var muted = body is { ValueKind: JsonValueKind.Object } element
      && element.TryGetProperty("muted", out var mutedProperty)
      && mutedProperty.ValueKind == JsonValueKind.True;

    var result = await mediator.Send(new SetMediaMuteCommand(muted), cancellationToken).ConfigureAwait(false);
    return Ok(result);
  }
}
