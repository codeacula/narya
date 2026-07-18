using FluentResults;

using Microsoft.AspNetCore.Mvc;

using Narya.Core.Actions;

namespace Narya.Api.Controllers;

/// <summary>
/// <c>/api/actions</c> (CRUD) — a port of legacy's <c>registerActionRoutes</c>
/// (<c>legacy/src/server/actions.ts</c>). Deliberately absent from
/// <see cref="Narya.Api.Auth.DashboardTokenMiddleware.OverlayPaths"/> — Actions are operator-only
/// configuration, mirroring <c>MediaAssetsController</c>.
///
/// <para>
/// Talks directly to <see cref="IActionStore"/> rather than routing through MediatR — same
/// precedent as <see cref="MediaAssetsController"/> and <see cref="AutomodController"/>: the route
/// needs to load-then-branch on 404/409 the way <see cref="Update"/>/<see cref="Create"/> do here
/// (an unknown id 404s before a validation failure would ever 400, and a name collision 409s
/// rather than 400ing), which a single <c>Result&lt;T&gt;</c> return alone cannot express.
/// </para>
/// </summary>
[ApiController]
[Route("api")]
public sealed class ActionsController(IActionStore store) : ControllerBase
{
  [HttpGet("actions")]
  public async Task<IActionResult> GetAll(CancellationToken cancellationToken)
  {
    // A bare array (not `{ actions: [...] }`) — legacy's `GET /api/actions` returns `Action[]`
    // directly, unlike MediaAssetsController's wrapped MediaAssetsResponse.
    var actions = await store.GetAllAsync(cancellationToken).ConfigureAwait(false);
    return Ok(actions);
  }

  [HttpPost("actions")]
  public async Task<IActionResult> Create([FromBody] ActionUpsert? body, CancellationToken cancellationToken)
  {
    var result = await store.CreateAsync(body ?? new ActionUpsert(), cancellationToken).ConfigureAwait(false);
    return result.IsFailed ? ToFailureResult(result) : StatusCode(StatusCodes.Status201Created, result.Value);
  }

  [HttpPut("actions/{id:guid}")]
  public async Task<IActionResult> Update(Guid id, [FromBody] ActionUpsert? body, CancellationToken cancellationToken)
  {
    var result = await store.UpdateAsync(id, body ?? new ActionUpsert(), cancellationToken).ConfigureAwait(false);
    return result switch
    {
      null => NotFound(new { error = "Action not found." }),
      { IsFailed: true } => ToFailureResult(result),
      _ => Ok(result.Value),
    };
  }

  [HttpDelete("actions/{id:guid}")]
  public async Task<IActionResult> Delete(Guid id, CancellationToken cancellationToken)
  {
    var deleted = await store.DeleteAsync(id, cancellationToken).ConfigureAwait(false);
    return deleted ? NoContent() : NotFound(new { error = "Action not found." });
  }

  /// <summary>
  /// Wired in Phase 4 Task 3, once the executor exists. An unknown id still 404s here (rather
  /// than the whole route 404ing, which would be indistinguishable from "no such route") so a
  /// caller can tell "this Action doesn't exist" apart from "running Actions isn't implemented
  /// yet".
  /// </summary>
  [HttpPost("actions/{id:guid}/run")]
  public async Task<IActionResult> Run(Guid id, CancellationToken cancellationToken)
  {
    var action = await store.GetByIdAsync(id, cancellationToken).ConfigureAwait(false);
    if (action is null)
    {
      return NotFound(new { error = "Action not found." });
    }

    return StatusCode(StatusCodes.Status501NotImplemented, new { error = "Running an Action is not wired up yet." });
  }

  /// <summary>
  /// A <see cref="DuplicateActionNameError"/> 409s; any other validation failure 400s — see
  /// <see cref="IActionStore.CreateAsync"/>'s doc comment.
  /// </summary>
  private IActionResult ToFailureResult(ResultBase result) =>
    result.HasError<DuplicateActionNameError>()
      ? Conflict(new { error = result.Errors[0].Message })
      : BadRequest(new { errors = result.Errors.Select(e => e.Message) });
}
