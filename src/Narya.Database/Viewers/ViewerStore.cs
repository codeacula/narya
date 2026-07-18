using System.Text.Json;

using Marten;

using Narya.Core.Viewers;
using Narya.Database.Chat;

namespace Narya.Database.Viewers;

/// <summary>
/// <see cref="IViewerStore"/> backed by <see cref="ViewerProfileDocument"/> and the existing
/// <see cref="ChatterDocument"/>/<c>ChatMessageDocument</c> — mirrors legacy's
/// <c>legacy/src/server/dashboard/status.ts</c> viewer routes.
///
/// <b>The roster needs no window-function join.</b> Legacy's <c>GET /api/viewers/roster</c>
/// joins <c>chat_messages</c> with <c>row_number() over (partition by username order by
/// received_at desc)</c> to find each chatter's most recent message. This port instead reads
/// <see cref="ChatterDocument.LastSeenAt"/>/<see cref="ChatterDocument.LastDisplayName"/>/
/// <see cref="ChatterDocument.LastColor"/>/<see cref="ChatterDocument.LastBadgesJson"/> — fields
/// <c>Narya.Database.Chat.ChatStore.UpsertChatterAsync</c> already maintains on every genuinely
/// new chat message specifically so this store's roster read is a single <c>chatters</c> scan.
/// </summary>
public sealed class ViewerStore(IDocumentStore store) : IViewerStore
{
  public async Task<ViewerProfileUpdate> UpsertProfileAsync(
    string login,
    string? realName,
    IReadOnlyList<string>? tags,
    string? note,
    DateTimeOffset occurredAt,
    CancellationToken cancellationToken)
  {
    var loginKey = login.ToLowerInvariant();
    var normalized = ViewerProfileNormalizer.Normalize(realName, tags, note);
    var tagsJson = JsonSerializer.Serialize(normalized.Tags);

    await using var session = store.LightweightSession();
    var existing = await session.LoadAsync<ViewerProfileDocument>(loginKey, cancellationToken);

    // CreatedAt is set ONLY on a genuine first insert and never touched on the update branch —
    // see IViewerStore.UpsertProfileAsync's doc comment for why that needs explicit care here
    // (Marten's Store replaces the whole document; there is no column-level SET the way
    // legacy's `ON CONFLICT DO UPDATE` gets it for free).
    var updated = existing is null
      ? new ViewerProfileDocument
      {
        Login = loginKey,
        RealName = normalized.RealName,
        TagsJson = tagsJson,
        Note = normalized.Note,
        CreatedAt = occurredAt,
        UpdatedAt = occurredAt,
      }
      : existing with
      {
        RealName = normalized.RealName,
        TagsJson = tagsJson,
        Note = normalized.Note,
        UpdatedAt = occurredAt,
      };

    session.Store(updated);
    await session.SaveChangesAsync(cancellationToken);

    return normalized;
  }

  public async Task<ViewerProfile?> GetProfileAsync(string login, CancellationToken cancellationToken)
  {
    await using var session = store.QuerySession();
    var doc = await session.LoadAsync<ViewerProfileDocument>(login.ToLowerInvariant(), cancellationToken);

    return doc is null
      ? null
      : new ViewerProfile(doc.Login, doc.RealName, DeserializeTags(doc.TagsJson), doc.Note, doc.CreatedAt, doc.UpdatedAt);
  }

  public async Task<IReadOnlyList<ViewerRosterEntry>> GetRosterAsync(CancellationToken cancellationToken)
  {
    await using var session = store.QuerySession();

    var chatters = await session.Query<ChatterDocument>().ToListAsync(cancellationToken);
    var profiles = await session.Query<ViewerProfileDocument>().ToListAsync(cancellationToken);
    var notesByLogin = profiles.ToDictionary(p => p.Login, p => p.Note, StringComparer.Ordinal);

    return [.. chatters
      .Select(c =>
      {
        var lastSeenAt = c.LastSeenAt ?? c.FirstSeenAt;
        return new ViewerRosterEntry(
          Login: c.Login,
          Display: c.LastDisplayName ?? c.Login,
          Color: c.LastColor ?? ViewerRoles.FallbackColor(c.Login),
          Roles: ViewerRoles.GetViewerRolesFromBadges(DeserializeBadges(c.LastBadgesJson)),
          MessageCount: c.MessageCount,
          FirstSeenAt: c.FirstSeenAt,
          LastSeenAt: lastSeenAt,
          Note: notesByLogin.GetValueOrDefault(c.Login, string.Empty));
      })
      .OrderByDescending(r => r.LastSeenAt)];
  }

  public async Task<IReadOnlyDictionary<string, Viewer>> GetRecentViewersAsync(int messageScanLimit, CancellationToken cancellationToken)
  {
    await using var session = store.QuerySession();

    var recentMessages = await session.Query<ChatMessageDocument>()
      .OrderByDescending(m => m.ReceivedAt)
      .Take(messageScanLimit)
      .ToListAsync(cancellationToken);

    var chatterLogins = await session.Query<ChatterDocument>()
      .Select(c => c.Login)
      .ToListAsync(cancellationToken);
    var knownChatters = new HashSet<string>(chatterLogins, StringComparer.Ordinal);

    var viewers = new Dictionary<string, Viewer>(StringComparer.Ordinal);
    var recentByLogin = new Dictionary<string, List<ViewerRecentMessage>>(StringComparer.Ordinal);

    // recentMessages is already newest-first, so the FIRST time a login is seen here IS its
    // most-recent message in the scan window — that seeds display/color/roles, matching
    // legacy's single top-to-bottom loop over `received_at desc` rows.
    foreach (var message in recentMessages)
    {
      var login = message.Username.ToLowerInvariant();
      if (!knownChatters.Contains(login))
      {
        continue; // defensive: mirrors legacy's `if (!count) continue;`
      }

      if (!viewers.ContainsKey(login))
      {
        var badges = DeserializeBadges(message.BadgesJson);
        var roles = ViewerRoles.GetViewerRolesFromBadges(badges);
        viewers[login] = new Viewer(
          Display: message.DisplayName,
          Color: message.Color ?? ViewerRoles.FallbackColor(login),
          Roles: roles,
          Followed: "not available",
          Subbed: roles.Contains("sub") ? "subscriber badge present" : "not available",
          AccountAge: "not available",
          Recent: []);
        recentByLogin[login] = [];
      }

      var recentList = recentByLogin[login];
      if (recentList.Count < 5)
      {
        recentList.Add(new ViewerRecentMessage(message.Message, message.ReceivedAt, DeserializeEmotes(message.EmotesJson)));
      }
    }

    return viewers.ToDictionary(
      kv => kv.Key,
      kv => kv.Value with { Recent = recentByLogin[kv.Key] },
      StringComparer.Ordinal);
  }

  private static List<string> DeserializeTags(string tagsJson) =>
    JsonSerializer.Deserialize<List<string>>(tagsJson) ?? [];

  private static Dictionary<string, string>? DeserializeBadges(string? badgesJson) =>
    badgesJson is null ? null : JsonSerializer.Deserialize<Dictionary<string, string>>(badgesJson);

  private static Dictionary<string, IReadOnlyList<string>>? DeserializeEmotes(string? emotesJson)
  {
    if (emotesJson is null)
    {
      return null;
    }

    var raw = JsonSerializer.Deserialize<Dictionary<string, List<string>>>(emotesJson);
    return raw?.ToDictionary(kv => kv.Key, kv => (IReadOnlyList<string>)kv.Value, StringComparer.Ordinal);
  }
}
