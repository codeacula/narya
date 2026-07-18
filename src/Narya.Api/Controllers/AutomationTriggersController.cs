using Microsoft.AspNetCore.Mvc;

using Narya.Core.Automation;

namespace Narya.Api.Controllers;

/// <summary>
/// <c>/api/automation/triggers</c> (CRUD) — a port of legacy's <c>registerAutomationTriggerRoutes</c>
/// (<c>legacy/src/server/automationTriggers.ts</c>), minus <c>POST /:id/run</c> and
/// <c>POST /api/automation/slash</c> (Phase 4 Task 6 — both need
/// <c>Narya.Application.Automation.ITriggerDispatcher</c>, which does not exist yet). Deliberately
/// absent from <see cref="Narya.Api.Auth.DashboardTokenMiddleware.OverlayPaths"/> — trigger
/// configuration is operator-only, mirroring <c>ActionsController</c>.
///
/// <para>
/// Talks directly to <see cref="IAutomationTriggerStore"/> rather than routing through MediatR —
/// same precedent as <c>ActionsController</c>: the route needs to load-then-branch on 404 the way
/// <see cref="Update"/>/<see cref="Delete"/> do here, which a single <c>Result&lt;T&gt;</c> return
/// alone cannot express.
/// </para>
/// </summary>
[ApiController]
[Route("api/automation/triggers")]
public sealed class AutomationTriggersController(IAutomationTriggerStore store) : ControllerBase
{
  [HttpGet]
  public async Task<IActionResult> GetAll(CancellationToken cancellationToken)
  {
    // A bare array (not `{ triggers: [...] }`) — matches legacy's `GET /api/automation/triggers`
    // returning `AutomationTrigger[]` directly, same shape as ActionsController.GetAll.
    var triggers = await store.GetAllAsync(cancellationToken).ConfigureAwait(false);
    return Ok(triggers);
  }

  [HttpPost]
  public async Task<IActionResult> Create([FromBody] AutomationTriggerUpsert? body, CancellationToken cancellationToken)
  {
    var result = await store.CreateAsync(body ?? new AutomationTriggerUpsert(), cancellationToken).ConfigureAwait(false);
    return result.IsFailed
      ? BadRequest(new { errors = result.Errors.Select(e => e.Message) })
      : StatusCode(StatusCodes.Status201Created, result.Value);
  }

  [HttpPut("{id:guid}")]
  public async Task<IActionResult> Update(Guid id, [FromBody] AutomationTriggerUpsert? body, CancellationToken cancellationToken)
  {
    var result = await store.UpdateAsync(id, body ?? new AutomationTriggerUpsert(), cancellationToken).ConfigureAwait(false);
    return result switch
    {
      null => NotFound(new { error = "Trigger not found." }),
      { IsFailed: true } => BadRequest(new { errors = result.Errors.Select(e => e.Message) }),
      _ => Ok(result.Value),
    };
  }

  [HttpDelete("{id:guid}")]
  public async Task<IActionResult> Delete(Guid id, CancellationToken cancellationToken)
  {
    var deleted = await store.DeleteAsync(id, cancellationToken).ConfigureAwait(false);
    return deleted ? NoContent() : NotFound(new { error = "Trigger not found." });
  }
}
