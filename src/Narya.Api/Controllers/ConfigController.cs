using FluentResults;

using MediatR;

using Microsoft.AspNetCore.Mvc;

using Narya.Application.AppConfig;
using Narya.Core.AppConfig;

namespace Narya.Api.Controllers;

/// <summary>
/// Deliberately absent from <see cref="Narya.Api.Auth.DashboardTokenMiddleware.OverlayPaths"/>
/// — an overlay browser source has no business reading or writing runtime configuration,
/// so the middleware already rejects an overlay-token caller with 403 before either action
/// here runs.
/// </summary>
[ApiController]
[Route("api/config")]
public sealed class ConfigController(IMediator mediator) : ControllerBase
{
  [HttpGet]
  public async Task<IActionResult> Get(CancellationToken cancellationToken)
  {
    var result = await mediator.Send(new GetAppConfigQuery(), cancellationToken).ConfigureAwait(false);
    return ToActionResult(result);
  }

  [HttpPut]
  public async Task<IActionResult> Put([FromBody] AppConfigPatch patch, CancellationToken cancellationToken)
  {
    var result = await mediator.Send(new UpdateAppConfigCommand(patch), cancellationToken).ConfigureAwait(false);
    return ToActionResult(result);
  }

  private IActionResult ToActionResult(Result<AppConfigResponse> result) =>
    result.IsFailed
      ? BadRequest(new { errors = result.Errors.Select(e => e.Message) })
      : Ok(result.Value);
}
