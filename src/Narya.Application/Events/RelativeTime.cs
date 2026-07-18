namespace Narya.Application.Events;

/// <summary>
/// Formats a relative "how long ago" label — a straight port of legacy's <c>formatAgo</c>
/// (<c>legacy/src/server/dashboard/status.ts</c>). Used only by
/// <see cref="GetRecentStreamEventsQueryHandler"/> today — the freshly-ingested broadcast in
/// <see cref="PersistStreamEventHandler"/> hardcodes the literal <c>"just now"</c>, matching
/// legacy's <c>emitStreamEvent</c>, which never called <c>formatAgo</c> at all.
/// </summary>
public static class RelativeTime
{
  public static string FormatAgo(DateTimeOffset receivedAt, DateTimeOffset now)
  {
    var totalSecs = Math.Max(0L, (long)(now - receivedAt).TotalSeconds);

    if (totalSecs < 60)
    {
      return "just now";
    }

    if (totalSecs < 3600)
    {
      var mins = totalSecs / 60;
      var secs = totalSecs % 60;
      return $"{mins}:{secs:D2}";
    }

    if (totalSecs < 86_400)
    {
      var hours = totalSecs / 3600;
      var mins = totalSecs % 3600 / 60;
      return $"{hours}h {mins}m";
    }

    var days = totalSecs / 86_400;
    if (days < 30)
    {
      return $"{days}d ago";
    }

    var months = days / 30;
    return $"{months}mo ago";
  }
}
