using Marten;
using Marten.Events.Projections;

using Narya.Database.AppConfig;
using Narya.Database.Common;

namespace Narya.Database;

/// <summary>
/// The single place Marten <see cref="StoreOptions"/> get configured. Both the
/// production DI registration (<c>AddNaryaDatabase</c>) and the Testcontainers-backed
/// test fixture call this, so test Marten == production Marten.
/// </summary>
public static class NaryaMartenConfig
{
  public static void Configure(StoreOptions options)
  {
    options.RegisterNaryaEvents(typeof(NaryaDatabase).Assembly);
    _ = options.Projections.Snapshot<DbAppConfig>(SnapshotLifecycle.Inline);
  }
}
