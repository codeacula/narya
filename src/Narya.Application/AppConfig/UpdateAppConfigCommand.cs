using FluentResults;

using FluentValidation;

using MediatR;

using Narya.Application.AppConfig.Notifications;
using Narya.Core.AppConfig;

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

public sealed class UpdateAppConfigCommandHandler(IAppConfigStore store, IMediator mediator)
  : IRequestHandler<UpdateAppConfigCommand, Result<AppConfigResponse>>
{
  public async Task<Result<AppConfigResponse>> Handle(
    UpdateAppConfigCommand request, CancellationToken cancellationToken)
  {
    var result = await store.UpdateAsync(request.Patch, cancellationToken);
    if (result.IsFailed)
    {
      return Result.Fail<AppConfigResponse>(result.Errors);
    }

    var response = AppConfigResponse.From(result.Value);
    await mediator.Publish(new AppConfigUpdatedNotification(response), cancellationToken);
    return Result.Ok(response);
  }
}
