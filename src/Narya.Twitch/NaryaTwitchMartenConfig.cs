using Marten;
using Marten.Events.Projections;

using Narya.Database.Common;
using Narya.Twitch.Tokens;

namespace Narya.Twitch;

/// <summary>
/// Narya.Twitch's additive Marten configuration — registers the Tokens event types and
/// the <see cref="DbTwitchToken"/> snapshot projection.
///
/// <para>
/// The Twitch events live in this assembly, but the shared <c>StoreOptions</c> are built
/// in Narya.Database (<c>NaryaMartenConfig.Configure</c>, scanning only
/// <c>typeof(NaryaDatabase).Assembly</c>). Narya.Database references Narya.Core/Domain
/// but deliberately not Narya.Twitch, so <c>NaryaMartenConfig</c> cannot reference this
/// type without a circular project reference. Instead, production composes the two
/// configurations additively through Marten's own DI extension point:
/// <see cref="ServiceCollectionExtensions.AddNaryaTwitch"/> calls
/// <c>services.ConfigureMarten(NaryaTwitchMartenConfig.Configure)</c>, which registers an
/// <c>IConfigureMarten</c> that Marten applies to the SAME <c>IDocumentStore</c> built by
/// <c>AddNaryaDatabase</c>'s <c>AddMarten(...)</c> — order of the two DI calls does not
/// matter, since the store is built lazily on first resolution, after the whole service
/// collection (both configuration contributions) is registered.
/// </para>
///
/// <para>
/// Tests that build a <see cref="StoreOptions"/> directly via <c>DocumentStore.For</c>
/// (bypassing DI entirely — <c>services.ConfigureMarten</c> has nothing to hook into
/// there) call this method the same way <c>AddNaryaTwitch</c> does, alongside
/// <c>NaryaMartenConfig.Configure</c>, so test Marten == production Marten for both
/// AppConfig and Twitch tokens.
/// </para>
/// </summary>
public static class NaryaTwitchMartenConfig
{
  public static void Configure(StoreOptions options)
  {
    options.RegisterNaryaEvents(typeof(NaryaTwitch).Assembly);
    _ = options.Projections.Snapshot<DbTwitchToken>(SnapshotLifecycle.Inline);
  }
}
