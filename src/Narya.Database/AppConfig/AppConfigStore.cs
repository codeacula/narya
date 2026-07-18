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
///
/// <para>
/// The aggregate is stored in two halves that share the one <see cref="RootId"/> identity:
/// the non-secret fields are event-sourced (<see cref="DbAppConfig"/>, so the audit trail
/// of when things changed survives), while the secret VALUES live in
/// <see cref="DbAppConfigSecrets"/>, a plain document written with overwrite semantics so
/// rotating a leaked secret actually erases the old one — an append-only stream cannot.
/// Both halves are written through the SAME <c>IDocumentSession</c> and committed by one
/// <c>SaveChangesAsync</c>, so a config update can never persist without its secrets or
/// vice versa. Callers see the composed <see cref="DomainConfig"/> and never know.
/// </para>
/// </summary>
public sealed class AppConfigStore(IDocumentStore store) : IAppConfigStore
{
  public static readonly Guid RootId = Guid.Parse("00000000-0000-0000-0000-000000000001");

  public async Task<Result<DomainConfig>> GetAsync(CancellationToken cancellationToken)
  {
    await using var session = store.QuerySession();
    var db = await session.LoadAsync<DbAppConfig>(RootId, cancellationToken);
    var secrets = await session.LoadAsync<DbAppConfigSecrets>(RootId, cancellationToken);

    // A missing secrets document composes to the domain defaults (empty strings), so a
    // deployment whose secrets were never written — or fully cleared — reads back cleanly.
    return Result.Ok((db ?? DbAppConfig.Default).ToDomain(secrets));
  }

  public async Task<Result<DomainConfig>> UpdateAsync(AppConfigPatch patch, CancellationToken cancellationToken)
  {
    var ev = patch.ToEvent(Guid.NewGuid(), DateTimeOffset.UtcNow);

    await using var session = store.LightweightSession();
    var streamState = await session.Events.FetchStreamStateAsync(RootId, cancellationToken);

    _ = streamState is null
      ? session.Events.StartStream<DbAppConfig>(RootId, ev)
      : session.Events.Append(RootId, ev);

    // Read-fold-overwrite in the same session as the event append: null patch fields leave
    // the stored secret alone, an explicit "" clears it — the same contract the event
    // projection applies to the non-secret fields.
    var currentSecrets = await session.LoadAsync<DbAppConfigSecrets>(RootId, cancellationToken);
    session.Store(patch.ToSecrets(RootId, currentSecrets));

    await session.SaveChangesAsync(cancellationToken);

    return await GetAsync(cancellationToken);
  }
}
