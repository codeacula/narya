namespace Narya.Core.Viewers;

/// <summary>
/// Two badge/login-derived display helpers a viewer roster/card needs — a port of legacy's
/// <c>fallbackColor</c> and <c>getViewerRolesFromBadges</c>
/// (<c>legacy/src/server/dashboard/status.ts</c> and <c>legacy/src/shared/roles.ts</c>
/// respectively).
///
/// Deliberately NOT implemented by delegating to <c>Narya.Twitch.Chat.ChatRoleResolver</c>
/// (which already ports the same badge-priority logic for chat role resolution): this project's
/// reference graph is Narya.Twitch → Narya.Database → Narya.Core, so neither Narya.Core (this
/// project) nor Narya.Database (where <c>Narya.Database.Viewers.ViewerStore</c>, the consumer,
/// lives) can reference Narya.Twitch without a cycle. <see cref="GetViewerRolesFromBadges"/>
/// therefore duplicates <c>ChatRoleResolver.ResolveAllRoles</c>'s badge-key-existence check
/// (not legacy's truthy-value check — see that method's doc comment for why key-existence is
/// this codebase's established simplification) rather than legacy's role list directly.
/// </summary>
public static class ViewerRoles
{
  /// <summary>
  /// Every role a chatter holds, broadcaster-first — a port of legacy's
  /// <c>getViewerRolesFromBadges</c> (<c>legacy/src/shared/roles.ts</c>). Returns the legacy
  /// short tokens (<c>"mod"</c>, <c>"sub"</c>, not <c>"moderator"</c>/<c>"subscriber"</c>) as
  /// that is what rides on the wire in <see cref="ViewerRosterEntry.Roles"/> and
  /// <see cref="Viewer.Roles"/>.
  /// </summary>
  public static IReadOnlyList<string> GetViewerRolesFromBadges(IReadOnlyDictionary<string, string>? badges)
  {
    if (badges is null)
    {
      return [];
    }

    List<string> roles = [];

    if (badges.ContainsKey("broadcaster"))
    {
      roles.Add("broadcaster");
    }

    if (badges.ContainsKey("moderator"))
    {
      roles.Add("mod");
    }

    if (badges.ContainsKey("vip"))
    {
      roles.Add("vip");
    }

    if (badges.ContainsKey("subscriber"))
    {
      roles.Add("sub");
    }

    return roles;
  }

  /// <summary>
  /// A deterministic display color for a viewer with no message-derived color yet — a straight
  /// port of legacy's <c>fallbackColor</c> (<c>legacy/src/server/dashboard/status.ts</c>): sum
  /// each character's UTF-16 code unit, mod the palette length, index into it. <c>login</c> is
  /// always an ASCII Twitch username in practice, so iterating <see cref="char"/> code units
  /// here is equivalent to legacy's <c>for (const char of login)</c> Unicode code-point
  /// iteration. Do not reorder the palette — it is a ground-truth vector every existing
  /// viewer's stored color hash depends on.
  /// </summary>
  public static string FallbackColor(string login)
  {
    string[] palette = ["#ffc488", "#d7dce2", "#a8e0c4", "#9ccae8", "#bca6f0", "#f0a99d", "#f5f2e0"];

    var hash = 0;
    foreach (var c in login)
    {
      hash = (hash + c) % palette.Length;
    }

    return palette[hash];
  }
}
