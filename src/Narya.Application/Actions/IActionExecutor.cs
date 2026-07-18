using Narya.Core.Actions;

namespace Narya.Application.Actions;

/// <summary>
/// Runs an <see cref="AutomationAction"/>'s steps — a port of legacy's <c>ActionExecutor</c>
/// (<c>legacy/src/server/actionExecutor.ts</c>). Implemented by <see cref="ActionExecutor"/>;
/// registered <c>AddSingleton&lt;IActionExecutor, ActionExecutor&gt;</c> (unguarded — see
/// <c>Narya.Application.ServiceCollectionExtensions</c>) since the executor itself needs no
/// infrastructure of its own, only its injected ports do. Called by
/// <c>Narya.Api.Controllers.ActionsController.Run</c> (<c>POST /api/actions/{id}/run</c>, which
/// bypasses cooldowns/dedup/logging — Phase 4 Task 6's trigger dispatcher owns those) and, from
/// Task 6 onward, by the trigger dispatcher for every armed trigger invocation.
/// </summary>
public interface IActionExecutor
{
  /// <summary>
  /// Loads <paramref name="actionId"/> and runs every step. Never throws for an ordinary failure —
  /// a missing/disabled Action, a muted <c>quickDisable</c> Action, and a step that throws all
  /// resolve to a <see cref="ActionRunResult"/> with the appropriate status; see
  /// <see cref="ActionExecutor"/>'s doc comment for the exact rules.
  /// </summary>
  Task<ActionRunResult> RunActionAsync(Guid actionId, TemplateContext context, CancellationToken cancellationToken);
}
