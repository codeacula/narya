namespace Narya.Core.Viewers;

/// <summary>
/// Pure trim/dedup normalization for a viewer profile edit — a port of the transform half of
/// legacy's <c>normalizeViewerProfileBody</c> (<c>legacy/src/server/dashboard/status.ts</c>).
/// The REJECT half (real name/note/tag length limits, tag count limit) is deliberately not
/// here — that lives in <c>Narya.Application.Viewers.UpdateViewerProfileCommandValidator</c> so
/// an out-of-bounds PATCH 400s before ever reaching the store. This method never fails: it is
/// also called directly by <c>Narya.Database.Viewers.ViewerStore.UpsertProfileAsync</c>, which
/// has no `Result` to fail with and must remain safe to call even from a path that bypassed the
/// command validator (a future migration script, a test).
/// </summary>
public static class ViewerProfileNormalizer
{
  public static ViewerProfileUpdate Normalize(string? realName, IReadOnlyList<string>? tags, string? note)
  {
    var normalizedRealName = (realName ?? string.Empty).Trim();
    var normalizedNote = (note ?? string.Empty).Trim();

    var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    var normalizedTags = new List<string>();
    foreach (var raw in tags ?? [])
    {
      if (raw is null)
      {
        continue;
      }

      var tag = raw.Trim();
      if (tag.Length == 0)
      {
        continue;
      }

      // Case-insensitive dedup, first casing wins: HashSet.Add returns false (and the tag is
      // skipped) for every occurrence after the first, so whichever casing arrived first in
      // `tags` is what ends up in the result — matches legacy's single left-to-right pass.
      if (seen.Add(tag))
      {
        normalizedTags.Add(tag);
      }
    }

    return new ViewerProfileUpdate(normalizedRealName, normalizedTags, normalizedNote);
  }
}
