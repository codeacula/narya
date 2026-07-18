using FluentResults;

using FluentValidation;

using MediatR;

using Narya.Application.AppConfig.Notifications;
using Narya.Core.AppConfig;
using Narya.Core.Twitch;

using DomainConfig = Narya.Domain.AppConfig.AppConfig;

namespace Narya.Application.AppConfig;

/// <summary>
/// Applies a partial update to the runtime configuration and returns the resulting
/// secret-masked client shape.
/// </summary>
public sealed record UpdateAppConfigCommand(AppConfigPatch Patch) : IRequest<Result<AppConfigResponse>>;

/// <summary>
/// Legacy clamps out-of-range <c>MusicPollIntervalMs</c>/volume values; this rejects them
/// instead, which is the cleaner behavior for a typed client. Bounds match legacy's
/// <c>clampNumber</c> calls. Every field is optional (null = "leave unchanged" per
/// <see cref="AppConfigPatch"/>), so an all-null patch is always valid.
/// </summary>
public sealed class UpdateAppConfigCommandValidator : AbstractValidator<UpdateAppConfigCommand>
{
  public UpdateAppConfigCommandValidator()
  {
    _ = RuleFor(x => x.Patch.MusicPollIntervalMs)
      .InclusiveBetween(0, 60000)
      .When(x => x.Patch.MusicPollIntervalMs is not null);

    _ = RuleFor(x => x.Patch.SoundVolume)
      .InclusiveBetween(0.0, 1.0)
      .When(x => x.Patch.SoundVolume is not null);
  }
}

/// <summary>
/// Ports the Twitch half of legacy's <c>reconcileServices</c>
/// (<c>legacy/src/server/index.ts</c>): a settings save that changes the channel or the Twitch
/// client credentials must drop the in-memory Twitch identity caches and rebind EventSub, so
/// the operator never has to restart the process after editing Settings.
/// </summary>
public sealed class UpdateAppConfigCommandHandler(
  IAppConfigStore store,
  IMediator mediator,
  ITwitchIdentityInvalidator twitchIdentityInvalidator)
  : IRequestHandler<UpdateAppConfigCommand, Result<AppConfigResponse>>
{
  public async Task<Result<AppConfigResponse>> Handle(
    UpdateAppConfigCommand request, CancellationToken cancellationToken)
  {
    // Read the pre-update config so the invalidation decision can be made on what ACTUALLY
    // changed rather than on which fields the patch mentions. The dashboard's Settings form
    // submits its whole Twitch section on every save, so "the patch names TwitchChannel" is
    // true even when the operator only moved the volume slider — reconnecting EventSub on that
    // would drop a live session for nothing. A failed read is not fatal: it only costs the
    // comparison its baseline, and the update itself is still the operator's request.
    // Pattern-matched rather than `beforeResult.IsSuccess`: with no baseline to compare against
    // the handler must fall back to invalidating unconditionally (below), which is the
    // conservative direction — a spare reconnect costs a re-subscribe, a missed one leaves the
    // process talking to the wrong channel until restart.
    var beforeResult = await store.GetAsync(cancellationToken);
    var before = beforeResult is { IsSuccess: true } ? beforeResult.Value : null;

    var result = await store.UpdateAsync(request.Patch, cancellationToken);
    if (result.IsFailed)
    {
      return Result.Fail<AppConfigResponse>(result.Errors);
    }

    // Exactly one call, however many Twitch fields moved in this one save — that is what keeps
    // a multi-field save from becoming a reconnect per field.
    if (before is null || TwitchIdentityChanged(before, result.Value))
    {
      await twitchIdentityInvalidator.InvalidateAsync(cancellationToken);
    }

    var response = AppConfigResponse.From(result.Value);
    await mediator.Publish(new AppConfigUpdatedNotification(response), cancellationToken);
    return Result.Ok(response);
  }

  /// <summary>
  /// The three fields that determine WHICH Twitch identity this process acts as or about:
  /// the channel (every Helix call's broadcaster id and every EventSub subscription's
  /// condition) and the client id/secret (the app access token is minted from them). Ordinal
  /// comparison — these are opaque identifiers and a secret, not display text. Everything else
  /// on <see cref="Narya.Domain.AppConfig.AppConfig"/> (OBS, Discord, volume, poll interval)
  /// is deliberately absent: changing one of those must not touch EventSub.
  /// </summary>
  private static bool TwitchIdentityChanged(DomainConfig before, DomainConfig after) =>
    !string.Equals(before.TwitchChannel, after.TwitchChannel, StringComparison.Ordinal)
    || !string.Equals(before.TwitchClientId, after.TwitchClientId, StringComparison.Ordinal)
    || !string.Equals(before.TwitchClientSecret, after.TwitchClientSecret, StringComparison.Ordinal);
}
