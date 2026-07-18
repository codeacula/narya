using Marten;
using Marten.Events.Projections;

using Narya.Database.AppConfig;
using Narya.Database.Common;
using Narya.Database.Sessions;

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

    // Plain (non-event-sourced) documents — see StreamSessionDocument's doc comment for why
    // sessions are a document rather than a snapshot projection. Indexed on Source (the
    // GetOrStartSessionAsync dedup lookup) and EndedAt (the "find the open session" lookup);
    // StreamSessionChatterDocument is indexed on SessionId (GetSessionChatterCountAsync).
    _ = options.Schema.For<StreamSessionDocument>()
      .Index(x => x.Source)
      .Index(x => x.EndedAt);
    _ = options.Schema.For<StreamSessionChatterDocument>()
      .Index(x => x.SessionId);
  }
}
