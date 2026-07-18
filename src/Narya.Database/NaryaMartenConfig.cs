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

    // The secret half of the app config (see DbAppConfigSecrets' doc comment). A plain
    // document, deliberately NOT event-sourced: it is overwritten in place so rotating a
    // secret erases the old value, which an append-only stream can never do. No index —
    // every read/write is a point lookup by the fixed AppConfigStore.RootId.
    _ = options.Schema.For<DbAppConfigSecrets>();

    // Plain (non-event-sourced) documents — see StreamSessionDocument's doc comment for why
    // sessions are a document rather than a snapshot projection. Indexed on EndedAt (the "find the
    // open session" lookup); StreamSessionChatterDocument on SessionId (GetSessionChatterCountAsync).
    //
    // TWO unique indexes, because the store enforces TWO distinct cross-row invariants and one
    // index cannot express both:
    //
    // 1. Source is UNIQUE — one session row per natural key, ever. GetOrStartSessionAsync's
    //    FindBySourceAsync dedup lookup is what this backs, and without the index that lookup is a
    //    pre-check two concurrent stream.online deliveries for the SAME stream id can both pass:
    //    the loser then CLOSES the winner's row inside its own transaction (legal as far as the
    //    OpenMarker index is concerned, since the conflicting index entry points at a tuple the
    //    loser itself just updated) and inserts a second row for that stream id. That leaves a
    //    zero-length phantom session and splits the stream's session-chatter accounting across two
    //    ids. Uniqueness on Source is what makes the loser's insert fail instead.
    // 2. OpenMarker carries a PARTIAL UNIQUE index — the same idiom as AutomationRunDocument's
    //    DedupeKey index below. OpenMarker is a computed property that is the constant "open" while
    //    EndedAt is null and null once the session ends (see StreamSessionDocument), so "unique
    //    where the marker is not null" reads as "at most one row in this table may be open." This
    //    is the cross-SOURCE half: two different stream ids going online at once.
    //
    // Unique indexes rather than optimistic concurrency, which guards ONE document's version and so
    // cannot see a second, different row being inserted — only an index expresses a constraint
    // ACROSS rows.
    _ = options.Schema.For<StreamSessionDocument>()
      .Index(x => x.Source, i => i.IsUnique = true)
      .Index(x => x.EndedAt)
      .Index(x => x.OpenMarker!, i =>
      {
        i.IsUnique = true;
        i.Predicate = "(data ->> 'OpenMarker') is not null";
      });
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
    //
    // OPTIMISTIC CONCURRENCY: a hold's resolution is a read-decide-write whose decision depends on
    // the CURRENTLY stored resolution and its source (AutomodResolutionSource precedence). A
    // unique index cannot express that rule and a raw conditional UPDATE would duplicate it in
    // SQL, so the version check is the mechanism instead: a resolution written against a stale
    // read is rejected, and AutomodStore.ResolveHoldAsync re-reads and re-decides. This is the
    // only document in the store that carries it — every other write path is either a point
    // overwrite with no read-derived decision, or already guarded by a unique index.
    _ = options.Schema.For<AutomodHoldDocument>()
      .Index(x => x.ResolvedAt)
      .Index(x => x.HeldAt)
      .UseOptimisticConcurrency(true);

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

    // Automation triggers (Phase 4 Task 5) — see AutomationTriggerDocument's doc comment. A
    // compound index on (Kind, Enabled) serves GetEnabledByKindAsync (the dispatcher's, Task 6,
    // read path — legacy's idx_automation_triggers_kind); ModuleId gets its own index for the
    // Phase 8 coordinator's future "triggers scoped to this module" lookup (legacy's
    // idx_automation_triggers_module). ActionId gets its own index for the referential-integrity
    // read behind ActionStore.DeleteAsync's refusal (AutomationTriggerQueries.ByActionIdAsync) —
    // it runs while an advisory lock is held, so it should not be a sequential scan.
    _ = options.Schema.For<AutomationTriggerDocument>()
      .Index([x => x.Kind, x => x.Enabled])
      .Index(x => x.ModuleId)
      .Index(x => x.ActionId);

    // The one-shot seed ledger (Phase 4 Task 5) — see SeedLedgerDocument's doc comment. No index:
    // every read/write is a point lookup by Id (the seed key itself).
    _ = options.Schema.For<SeedLedgerDocument>();

    // The automation invocation/dedupe log (Phase 4 Task 6) — see AutomationRunDocument's doc
    // comment. DedupeKey gets a PARTIAL UNIQUE index: unique only where the computed JSONB path is
    // non-null, so a manual/module-lifecycle run's null DedupeKey is exempt (Postgres already
    // treats every NULL as distinct for a plain unique index, but the explicit predicate also keeps
    // the index small — it only ever covers rows that actually carry a source event id) while two
    // inserts for the SAME "{triggerId}:{eventId}" collide, and the second insert's exception is
    // IAutomationRunStore.TryClaimAsync's dedup signal. Predicate syntax confirmed against Marten
    // 8.37.4's own computed-index docs: the predicate is raw SQL over the same
    // `data ->> 'PropertyName'` expression the index itself is built from. (TriggerId, RanAt) and
    // (TriggerId, ActorLogin, RanAt) serve the global/user cooldown reads TryClaimAsync now makes
    // under its per-trigger advisory lock — legacy's idx_automation_runs_cooldown/
    // idx_automation_runs_user_cooldown.
    _ = options.Schema.For<AutomationRunDocument>()
      .Index(x => x.DedupeKey, i =>
      {
        i.IsUnique = true;
        i.Predicate = "(data ->> 'DedupeKey') is not null";
      })
      .Index([x => x.TriggerId, x => x.RanAt])
      // ActorLogin is nullable (a manual/module-lifecycle run has no actor) — the null-forgiving
      // operator only silences the boxing-to-object warning below; Marten's index only cares
      // about the property path, not this expression's static nullability.
      .Index([x => x.TriggerId, x => x.ActorLogin!, x => x.RanAt]);
  }
}
