using MediatR;

using Microsoft.AspNetCore.Mvc;

using Narya.Application.Automod;
using Narya.Core.AppConfig;
using Narya.Core.Automod;
using Narya.Twitch.Helix;

namespace Narya.Api.Controllers;

/// <summary>
/// AutoMod hold queue — a port of legacy's <c>GET /api/automod/queue</c> and
/// <c>POST /api/automod/:id/allow|deny</c> (<c>legacy/src/server/routes.ts</c>). Deliberately
/// absent from <see cref="Narya.Api.Auth.DashboardTokenMiddleware.OverlayPaths"/> — moderated
/// content and moderation actions are operator-only, matching <c>automod:held</c>/
/// <c>automod:resolved</c>'s absence from <see cref="Narya.Core.Realtime.RealtimeEventNames.OverlayAllowlist"/>.
/// An overlay-token GET here 403s the same way <c>GET /api/chat/events/recent</c> does; a POST
/// 403s regardless of path, since the middleware only ever admits an overlay token on a GET.
///
/// <para>
/// The allow/deny orchestration bypasses MediatR — unlike <see cref="GetQueue"/> (a plain
/// <see cref="IMediator"/> query), it needs <see cref="IHelixClient"/> (Narya.Twitch), and
/// Narya.Application deliberately does not reference Narya.Twitch (see
/// <c>Narya.Core.Chat.ChatMessageIngestedNotification</c>'s doc comment for the same
/// reference-direction constraint). <c>Narya.Api.Controllers.TwitchAuthController</c> is the
/// precedent for a controller directly orchestrating a Narya.Twitch service rather than routing
/// through a MediatR handler.
/// </para>
/// </summary>
[ApiController]
[Route("api/automod")]
public sealed class AutomodController(
  IMediator mediator, IAutomodStore automodStore, IHelixClient helixClient, IAppConfigStore appConfigStore) : ControllerBase
{
  [HttpGet("queue")]
  public async Task<IActionResult> GetQueue(CancellationToken cancellationToken)
  {
    var queue = await mediator.Send(new GetAutomodQueueQuery(), cancellationToken).ConfigureAwait(false);
    return Ok(queue);
  }

  [HttpPost("{id}/allow")]
  public Task<IActionResult> Allow(string id, CancellationToken cancellationToken) =>
    ResolveAsync(id, allow: true, cancellationToken);

  [HttpPost("{id}/deny")]
  public Task<IActionResult> Deny(string id, CancellationToken cancellationToken) =>
    ResolveAsync(id, allow: false, cancellationToken);

  /// <summary>
  /// Checks the local hold first — an unknown id 404s without any Twitch side effect, and an
  /// already-resolved hold (EventSub won the race) returns idempotently instead of calling Helix
  /// again — matches legacy's <c>routes.ts</c> allow/deny handler exactly, including the
  /// "gone means expired, non-authoritative" and "ok means allowed/denied, authoritative" mapping.
  /// </summary>
  private async Task<IActionResult> ResolveAsync(string id, bool allow, CancellationToken cancellationToken)
  {
    var existing = await automodStore.GetHoldAsync(id, cancellationToken).ConfigureAwait(false);
    if (existing is null)
    {
      return NotFound(new { error = "AutoMod hold not found." });
    }

    if (existing.ResolvedAt is not null)
    {
      return Ok(existing);
    }

    var helixResult = await helixClient.ResolveAutomodMessageAsync(id, allow, cancellationToken).ConfigureAwait(false);
    if (helixResult.IsFailed)
    {
      return StatusCode(StatusCodes.Status502BadGateway, new { errors = helixResult.Errors.Select(e => e.Message) });
    }

    // 'gone' is a guess — Twitch no longer knows the hold, so we assume it aged out. A later
    // automod.message.update carrying the real verdict (ResolveAutomodHoldHandler) can still
    // overturn this exactly once — mirrors legacy's routes.ts comment on this exact branch.
    AutomodResolveResult result;
    if (helixResult.Value.Outcome == AutomodOutcomes.Gone)
    {
      result = await automodStore.ResolveHoldAsync(id, "expired", null, AutomodResolutionSource.Speculative, cancellationToken)
        .ConfigureAwait(false);
    }
    else
    {
      // Dashboard precedence, not EventSub: this is our report of a Helix call we made, and a
      // later automod.message.update from Twitch itself outranks it — see AutomodResolutionSource.
      var resolvedBy = await ResolveModeratorLoginAsync(cancellationToken).ConfigureAwait(false);
      result = await automodStore.ResolveHoldAsync(
          id, allow ? "allowed" : "denied", resolvedBy, AutomodResolutionSource.Dashboard, cancellationToken)
        .ConfigureAwait(false);
    }

    if (result.Changed && result.Hold is not null)
    {
      await mediator.Publish(new AutomodResolvedBroadcastNotification(result.Hold), cancellationToken).ConfigureAwait(false);
    }

    return Ok(result.Hold ?? existing);
  }

  /// <summary>
  /// <see cref="IHelixClient.ResolveAutomodMessageAsync"/> resolves credentials via
  /// <c>ITwitchCredentials.GetActionCredentialsAsync</c>, which always uses the broadcaster's own
  /// token (never the bot's) — so the account that just performed the allow/deny IS the
  /// configured channel. Legacy instead round-trips a Helix self-lookup
  /// (<c>getAuthenticatedActionUser</c>) to learn the acting login; this port's
  /// <see cref="IHelixClient"/> has no equivalent call (Phase 2 scoped it out — see that
  /// interface's DEFERRED note), so this reads the same value
  /// <c>Narya.Application.Chat.PersistChatMessageHandler.IsChannelOwnerAsync</c> already trusts
  /// as "the broadcaster's login" instead of adding a network round trip for it. Null (not
  /// "unknown") when the channel isn't configured — matches <see cref="AutomodHold.ResolvedBy"/>'s
  /// nullable contract.
  /// </summary>
  private async Task<string?> ResolveModeratorLoginAsync(CancellationToken cancellationToken)
  {
    var configResult = await appConfigStore.GetAsync(cancellationToken).ConfigureAwait(false);
    return configResult.IsFailed || string.IsNullOrEmpty(configResult.Value.TwitchChannel)
      ? null
      : configResult.Value.TwitchChannel;
  }
}
