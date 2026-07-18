using Marten;
using Marten.Events.Projections;
using Marten.Schema;

using Narya.Database.Actions;
using Narya.Database.AppConfig;
using Narya.Database.Automation;
using Narya.Database.Automod;
using Narya.Database.Chat;
using Narya.Database.Common;
using Narya.Database.Events;
using Narya.Database.Media;
using Narya.Database.Sessions;
using Narya.Database.Viewers;

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

    // Chat dual-layer persistence (Phase 3 Task 1) — see ChatMessageDocument/ChatEventDocument's
    // doc comments. ChatMessageDocument is indexed on Username (Task 5's per-viewer-messages
    // query scans by it) and ReceivedAt (GetRecentMessagesAsync); ChatEventDocument on
    // OccurredAt (GetRecentEventsAsync). ChatterDocument has no separate Id property — Login
    // itself is the identity, configured explicitly since it's the one document in this
    // project without a convention-matching Id.
    _ = options.Schema.For<ChatMessageDocument>()
      .Index(x => x.Username)
      .Index(x => x.ReceivedAt);
    _ = options.Schema.For<ChatEventDocument>()
      .Index(x => x.OccurredAt);
    _ = options.Schema.For<ChatterDocument>()
      .Identity(x => x.Login);

    // Stream event persistence (Phase 3 Task 4) — see StreamEventDocument's doc comment.
    // Indexed on ReceivedAt (GetRecentAsync's ordering) and SessionId (Phase 3 Task 7's
    // GetSessionShoutoutEventsAsync, scoped to the current session).
    _ = options.Schema.For<StreamEventDocument>()
      .Index(x => x.ReceivedAt)
      .Index(x => x.SessionId);

    // Viewer profiles (Phase 3 Task 5) — see ViewerProfileDocument's doc comment. Login itself
    // is the identity, same no-separate-Id pattern as ChatterDocument.
    _ = options.Schema.For<ViewerProfileDocument>()
      .Identity(x => x.Login);

    // AutoMod hold queue (Phase 3 Task 6) — see AutomodHoldDocument's doc comment. Indexed on
    // ResolvedAt (the pending/resolved partition every query filters on, and the sweep) and
    // HeldAt (pending ordering, and the sweep's staleness cutoff).
    _ = options.Schema.For<AutomodHoldDocument>()
      .Index(x => x.ResolvedAt)
      .Index(x => x.HeldAt);

    // The configured media catalog (Phase 4 Task 1) — see MediaAssetDocument's doc comment.
    // Indexed on Label (MediaAssetStore.GetAllAsync's ordering).
    _ = options.Schema.For<MediaAssetDocument>()
      .Index(x => x.Label);

    // Actions + embedded steps (Phase 4 Task 2) — see ActionDocument's doc comment. Name is a
    // REAL case-insensitive unique database constraint (Casing = Lower generates the index over
    // lower(data ->> 'Name'), IsUnique = true makes it a unique index) rather than app-level
    // enforcement — the Postgres equivalent of legacy's SQLite `name text not null unique` +
    // `order by name collate nocase`, so "Hype" and "hype" collide the same way.
    // ActionStore.IsUniqueNameViolation catches the resulting 23505 and translates it to a typed
    // DuplicateActionNameError instead of letting the raw exception propagate.
    _ = options.Schema.For<ActionDocument>()
      .Index(x => x.Name, i =>
      {
        i.IsUnique = true;
        i.Casing = ComputedIndex.Casings.Lower;
      });

    // The master media-mute switch (Phase 4 Task 4) — see MediaMuteDocument's doc comment. No
    // index configured: every read/write is a point lookup by the fixed
    // MediaMuteStore.RootId, never a scan or a filter on any other field.
    _ = options.Schema.For<MediaMuteDocument>();
  }
}
