namespace Narya.Database.Viewers;

/// <summary>
/// The mutable <c>chatters</c> projection — a port of legacy's table
/// (<c>legacy/src/server/db.ts</c>), extended with last-message fields ahead of Task 5's
/// viewer roster. <see cref="Login"/> (lowercased) is the natural key/identity — configured
/// via <c>options.Schema.For&lt;ChatterDocument&gt;().Identity(x =&gt; x.Login)</c> in
/// <c>Narya.Database.NaryaMartenConfig</c>, since (unlike every other document in this
/// project) there is no separate <c>Id</c> property here: the login itself IS the identity,
/// with no derivation or composite-key need the way
/// <c>Narya.Database.Sessions.StreamSessionChatterDocument.Id</c> needed one.
///
/// <see cref="MessageCount"/>/<see cref="FirstSeenAt"/> mirror legacy's
/// <c>on conflict(login) do update set message_count = message_count + 1</c> upsert exactly —
/// <see cref="Narya.Database.Chat.ChatStore.UpsertChatterAsync"/> increments on every call and
/// never touches <see cref="FirstSeenAt"/> after the first insert.
///
/// <see cref="LastSeenAt"/>/<see cref="LastDisplayName"/>/<see cref="LastColor"/>/
/// <see cref="LastBadgesJson"/> are a Narya-specific addition beyond legacy's schema: legacy's
/// roster endpoint (<c>legacy/src/server/dashboard/status.ts</c>) joined <c>chat_messages</c>
/// with a <c>row_number() partition by username order by received_at desc</c> window function
/// to find each chatter's most recent message. Maintaining the same fields directly on this
/// document — updated by <c>ChatStore.UpsertChatterAsync</c> on every genuinely new message —
/// lets Task 5's roster read be a single scan of <c>chatters</c> instead of that join.
/// </summary>
public sealed record ChatterDocument
{
  public string Login { get; init; } = string.Empty;

  public DateTimeOffset FirstSeenAt { get; init; }

  public int MessageCount { get; init; }

  public DateTimeOffset? LastSeenAt { get; init; }

  public string? LastDisplayName { get; init; }

  public string? LastColor { get; init; }

  public string? LastBadgesJson { get; init; }
}
