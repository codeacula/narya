using Marten;

using Narya.Core.Automation;

namespace Narya.Database.Automation;

/// <summary>
/// <see cref="IMediaMuteStore"/> backed by the plain (non-event-sourced) <see cref="MediaMuteDocument"/>
/// — mirrors legacy's <c>mediaMute.ts</c> store half. Single row keyed by <see cref="RootId"/>, a
/// fixed literal rather than something callers supply, same pattern as
/// <c>Narya.Database.AppConfig.AppConfigStore.RootId</c>.
///
/// <para>
/// Deliberately does NOT publish the <c>media:mute</c> realtime broadcast itself —
/// <c>Narya.Application.Automation.SetMediaMuteCommandHandler</c> owns that (persist here first,
/// publish after), matching <c>Narya.Database.AppConfig.AppConfigStore</c>/
/// <c>Narya.Application.AppConfig.UpdateAppConfigCommandHandler</c>'s split: a store is a pure
/// persistence boundary, and only the command handler that already knows the write committed
/// decides when it is safe to tell the realtime bridge about it.
/// </para>
/// </summary>
public sealed class MediaMuteStore(IDocumentStore store) : IMediaMuteStore
{
  public static readonly Guid RootId = Guid.Parse("00000000-0000-0000-0000-000000000001");

  public async Task<bool> GetMutedAsync(CancellationToken cancellationToken)
  {
    await using var session = store.QuerySession();
    var doc = await session.LoadAsync<MediaMuteDocument>(RootId, cancellationToken);
    return doc?.Muted ?? false;
  }

  public async Task<MediaMuteState> SetMutedAsync(bool muted, CancellationToken cancellationToken)
  {
    await using var session = store.LightweightSession();
    session.Store(new MediaMuteDocument { Id = RootId, Muted = muted });
    await session.SaveChangesAsync(cancellationToken);
    return new MediaMuteState(muted);
  }
}
