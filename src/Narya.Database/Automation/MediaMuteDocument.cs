namespace Narya.Database.Automation;

/// <summary>
/// The <c>media_mute</c> projection — a plain (non-event-sourced) single-row document, a port of
/// legacy's <c>media_mute</c> table (<c>legacy/src/server/db.ts</c>: <c>id integer primary key
/// check (id = 1), muted integer not null default 0</c>). Always stored/loaded at the fixed
/// <c>Narya.Database.Automation.MediaMuteStore.RootId</c> — mirrors
/// <c>Narya.Database.AppConfig.AppConfigStore.RootId</c>'s singleton-identity pattern, just for a
/// plain document instead of an event-sourced aggregate: there is no history worth keeping for a
/// single on/off flag, so an upsert (<c>session.Store</c>) replacing the row in place is the direct
/// translation of legacy's <c>insert ... on conflict(id) do update</c>.
///
/// <para>
/// Must be public — Marten generates document-storage code at runtime and a private/internal
/// document type fails storage codegen (the same lesson <c>MartenSmokeTests.Doc</c> documents).
/// </para>
/// </summary>
public sealed record MediaMuteDocument
{
  public Guid Id { get; init; }

  public bool Muted { get; init; }
}
