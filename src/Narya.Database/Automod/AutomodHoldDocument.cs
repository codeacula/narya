using Narya.Core.Automod;

namespace Narya.Database.Automod;

/// <summary>
/// The <c>automod_holds</c> projection — a port of legacy's table (<c>legacy/src/server/db.ts</c>).
/// <see cref="Id"/> is Twitch's own message id, not a synthetic identifier — the natural key
/// <c>Narya.Database.Automod.AutomodStore.RecordHoldAsync</c> dedups a redelivery against.
///
/// <para>
/// Must be public — Marten generates document-storage code at runtime and a private/internal
/// document type fails storage codegen (the same lesson <c>MartenSmokeTests.Doc</c> documents).
/// </para>
/// </summary>
public sealed record AutomodHoldDocument
{
  public string Id { get; init; } = string.Empty;

  public string Channel { get; init; } = string.Empty;

  /// <summary>Lowercased Twitch login of the message's sender.</summary>
  public string Username { get; init; } = string.Empty;

  public string DisplayName { get; init; } = string.Empty;

  public string Message { get; init; } = string.Empty;

  /// <summary>AutoMod's caught-message category. Null when the hold was caught by a blocked term instead.</summary>
  public string? Category { get; init; }

  /// <summary>AutoMod's severity level (1-4). Null alongside <see cref="Category"/>.</summary>
  public int? Level { get; init; }

  public DateTimeOffset HeldAt { get; init; }

  /// <summary>Null until resolved (allowed/denied/expired).</summary>
  public DateTimeOffset? ResolvedAt { get; init; }

  /// <summary>One of <c>allowed</c>, <c>denied</c>, or <c>expired</c> once <see cref="ResolvedAt"/> is set; null until then.</summary>
  public string? Resolution { get; init; }

  /// <summary>
  /// The moderator login (or, for the EventSub-sourced authoritative resolution, Twitch's
  /// moderator display name — see <c>Narya.Core.Automod.AutomodResolvedNotification</c>'s doc
  /// comment) who resolved the hold. Null for a sweep-expired or Helix-"gone" resolution, both of
  /// which have no human moderator behind them.
  /// </summary>
  public string? ResolvedBy { get; init; }

  /// <summary>
  /// Where <see cref="Resolution"/> came from, and therefore which of two colliding resolutions
  /// wins — see <see cref="AutomodResolutionSource"/>. Meaningless while <see cref="ResolvedAt"/>
  /// is null.
  ///
  /// <para>
  /// The initializer is <see cref="AutomodResolutionSource.Speculative"/>, the domain default and
  /// the LOWEST precedence, deliberately: a hold document written before this field existed
  /// deserializes to it, and the honest reading of a resolution whose provenance was never
  /// recorded is "unknown, so let any real verdict overturn it" — not "unoverturnable."
  /// </para>
  /// </summary>
  public AutomodResolutionSource ResolvedSource { get; init; } = AutomodResolutionSource.Speculative;
}
