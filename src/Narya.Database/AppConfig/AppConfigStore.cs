using FluentResults;

using Marten;

using Narya.Core.AppConfig;

using DomainConfig = Narya.Domain.AppConfig.AppConfig;

namespace Narya.Database.AppConfig;

/// <summary>
/// Single-stream aggregate keyed by <see cref="RootId"/> — there is exactly one
/// <c>AppConfig</c> per deployment, so the stream identity is a fixed literal rather
/// than something callers supply (mirrors Apollo's <c>ConfigurationId.Root</c>
/// singleton pattern).
/// </summary>
public sealed class AppConfigStore(IDocumentStore store) : IAppConfigStore
{
  public static readonly Guid RootId = Guid.Parse("00000000-0000-0000-0000-000000000001");

  public async Task<Result<DomainConfig>> GetAsync(CancellationToken cancellationToken)
  {
    await using var session = store.QuerySession();
    var db = await session.LoadAsync<DbAppConfig>(RootId, cancellationToken);
    return Result.Ok(db is null ? new DomainConfig() : (DomainConfig)db);
  }

  public async Task<Result<DomainConfig>> UpdateAsync(AppConfigPatch patch, CancellationToken cancellationToken)
  {
    var ev = patch.ToEvent(Guid.NewGuid(), DateTimeOffset.UtcNow);

    await using var session = store.LightweightSession();
    var streamState = await session.Events.FetchStreamStateAsync(RootId, cancellationToken);

    _ = streamState is null
      ? session.Events.StartStream<DbAppConfig>(RootId, ev)
      : session.Events.Append(RootId, ev);

    await session.SaveChangesAsync(cancellationToken);

    return await GetAsync(cancellationToken);
  }
}
