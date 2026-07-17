using FluentResults;

using DomainConfig = Narya.Domain.AppConfig.AppConfig;

namespace Narya.Core.AppConfig;

/// <summary>
/// The single-stream, event-sourced store for the runtime <see cref="DomainConfig"/>
/// aggregate. Implemented in Narya.Database (<c>AppConfigStore</c>); this interface is
/// what the rest of the application depends on.
/// </summary>
public interface IAppConfigStore
{
  Task<Result<DomainConfig>> GetAsync(CancellationToken cancellationToken);

  Task<Result<DomainConfig>> UpdateAsync(AppConfigPatch patch, CancellationToken cancellationToken);
}
