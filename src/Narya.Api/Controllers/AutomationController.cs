using Microsoft.AspNetCore.Mvc;

using Narya.Application.Automation;
using Narya.Core.Automation;

namespace Narya.Api.Controllers;

/// <summary>
/// <c>POST /api/automation/slash</c> — the operator's private dashboard command bar (Phase 4
/// Task 6), a port of legacy's slash-command route in <c>legacy/src/server/automationTriggers.ts</c>.
/// Deliberately absent from <see cref="Narya.Api.Auth.DashboardTokenMiddleware.OverlayPaths"/> — an
/// unauthenticated overlay browser source has no business running the operator's commands.
///
/// <para>
/// A separate controller from <see cref="AutomationTriggersController"/> (rather than one more
/// route on it) because this one is not scoped to a trigger id — <c>ITriggerDispatcher.HandleSlashCommandAsync</c>
/// resolves the id itself from the command word.
/// </para>
/// </summary>
[ApiController]
[Route("api/automation")]
public sealed class AutomationController(ITriggerDispatcher dispatcher) : ControllerBase
{
  /// <summary>
  /// ALWAYS returns HTTP 200 — an unknown command, a typo, or a cooling-down trigger is
  /// <c>{ ok: false, message: "..." }</c>, never an HTTP error and never forwarded to Twitch. See
  /// <see cref="ITriggerDispatcher.HandleSlashCommandAsync"/>'s doc comment.
  /// </summary>
  [HttpPost("slash")]
  public async Task<IActionResult> Slash([FromBody] SlashCommandRequest? body, CancellationToken cancellationToken)
  {
    var response = await dispatcher.HandleSlashCommandAsync(body?.Input, cancellationToken).ConfigureAwait(false);
    return Ok(response);
  }
}
