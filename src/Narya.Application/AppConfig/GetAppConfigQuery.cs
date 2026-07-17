using FluentResults;

using MediatR;

using Narya.Core.AppConfig;

namespace Narya.Application.AppConfig;

/// <summary>
/// Fetches the current runtime configuration as its secret-masked client shape.
/// </summary>
public sealed record GetAppConfigQuery : IRequest<Result<AppConfigResponse>>;

public sealed class GetAppConfigQueryHandler(IAppConfigStore store)
  : IRequestHandler<GetAppConfigQuery, Result<AppConfigResponse>>
{
  public async Task<Result<AppConfigResponse>> Handle(GetAppConfigQuery request, CancellationToken cancellationToken)
  {
    var result = await store.GetAsync(cancellationToken);
    return result.IsFailed
      ? Result.Fail<AppConfigResponse>(result.Errors)
      : Result.Ok(AppConfigResponse.From(result.Value));
  }
}
