using FluentResults;

using FluentValidation;

using MediatR;

using Narya.Core.Viewers;

namespace Narya.Application.Viewers;

/// <summary>
/// A port of legacy's <c>PATCH /api/dashboard/viewers/:login/profile</c>
/// (<c>legacy/src/server/dashboard/status.ts</c>). <see cref="Login"/> comes from the route,
/// the rest from the request body (<see cref="ViewerProfileUpdateRequest"/>).
/// </summary>
public sealed record UpdateViewerProfileCommand(
  string Login, string? RealName, IReadOnlyList<string>? Tags, string? Note) : IRequest<Result<ViewerProfileUpdate>>;

/// <summary>
/// The REJECT half of legacy's <c>normalizeViewerProfileBody</c> — bounds-checks the raw
/// request before <see cref="UpdateViewerProfileCommandHandler"/> ever calls
/// <c>IViewerStore.UpsertProfileAsync</c>, which normalizes (trims/dedupes) but never rejects.
/// Checks run against TRIMMED length, matching legacy's trim-then-check order exactly.
/// </summary>
public sealed class UpdateViewerProfileCommandValidator : AbstractValidator<UpdateViewerProfileCommand>
{
  public UpdateViewerProfileCommandValidator()
  {
    _ = RuleFor(x => x.Login)
      .Must(login => !string.IsNullOrWhiteSpace(login))
      .WithMessage("Viewer login is required.");

    _ = RuleFor(x => x.RealName)
      .Must(realName => (realName ?? string.Empty).Trim().Length <= 120)
      .WithMessage("Real name must be 120 characters or fewer.");

    _ = RuleFor(x => x.Note)
      .Must(note => (note ?? string.Empty).Trim().Length <= 1000)
      .WithMessage("Note must be 1000 characters or fewer.");

    // Raw count, before trimming/dedup — matches legacy's `if (inputTags.length > 12) throw`,
    // which rejects on the incoming array length even if some entries turn out to be
    // duplicates or empty-after-trim.
    _ = RuleFor(x => x.Tags)
      .Must(tags => (tags?.Count ?? 0) <= 12)
      .WithMessage("A viewer can have at most 12 tags.");

    // A JSON array element that deserializes to a non-string type (number/object/bool) already
    // fails ASP.NET model binding with a 400 before this validator ever runs; a JSON `null`
    // element binds successfully to a `string` slot, so it needs this explicit check to match
    // legacy's `if (typeof item !== 'string') throw new HttpRouteError(400, 'Tags must be
    // strings.')`.
    _ = RuleForEach(x => x.Tags)
      .Must(tag => tag is not null)
      .WithMessage("Tags must be strings.");

    _ = RuleForEach(x => x.Tags)
      .Must(tag => tag is null || tag.Trim().Length <= 32)
      .WithMessage("Tags must be 32 characters or fewer.");
  }
}

public sealed class UpdateViewerProfileCommandHandler(IViewerStore store, TimeProvider timeProvider)
  : IRequestHandler<UpdateViewerProfileCommand, Result<ViewerProfileUpdate>>
{
  public async Task<Result<ViewerProfileUpdate>> Handle(UpdateViewerProfileCommand request, CancellationToken cancellationToken)
  {
    var login = request.Login.Trim().ToLowerInvariant();
    var updated = await store.UpsertProfileAsync(
      login, request.RealName, request.Tags, request.Note, timeProvider.GetUtcNow(), cancellationToken)
      .ConfigureAwait(false);

    return Result.Ok(updated);
  }
}
