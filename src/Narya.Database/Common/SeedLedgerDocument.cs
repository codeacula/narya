namespace Narya.Database.Common;

/// <summary>
/// A one-shot-migration ledger row — the Marten equivalent of legacy's <c>schema_migrations</c>
/// table (<c>legacy/src/server/db.ts</c>'s <c>runOnce</c>). <see cref="Id"/> IS the migration/seed
/// key (e.g. <c>"seed-builtin-dashboard-slash-commands"</c>), not a generated identifier — a plain
/// point lookup by that key is how a caller checks "has this already run", matching legacy's
/// <c>hasMigrationRun.get(id)</c>.
///
/// <para>
/// There is deliberately no shared "run this exactly once" helper method (legacy's <c>runOnce</c>)
/// alongside this record: the one current consumer,
/// <c>Narya.Database.Automation.BuiltInSlashCommandSeeder</c>, needs its ledger insert to share the
/// SAME session/transaction as several other document inserts (4 Actions + 4 triggers), so it opens
/// its own session and stages everything — including this row — before one
/// <c>SaveChangesAsync</c>. A generic wrapper that owned its own session could not give a caller
/// that transactional boundary; if a second seed arrives with the same shape, promote the
/// check-then-stage pattern below into a shared helper then, rather than speculatively generalizing
/// from a single call site now.
/// </para>
///
/// <para>
/// Must be public — Marten generates document-storage code at runtime and a private/internal
/// document type fails storage codegen (the same lesson <c>MartenSmokeTests.Doc</c> documents).
/// </para>
/// </summary>
public sealed record SeedLedgerDocument
{
  public string Id { get; init; } = string.Empty;

  public DateTimeOffset AppliedAt { get; init; }
}
