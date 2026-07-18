namespace Narya.Twitch.Helix;

/// <summary>
/// In-memory, per-process caches for the two Helix reads legacy also cached in-process rather
/// than hitting Twitch on every dashboard poll (<c>legacy/src/server/dashboard/status.ts</c>:
/// 15s for stream status, 5s for the ad schedule). A Redis-backed cache is unnecessary here —
/// Narya is single-operator, single-process, and these windows are short enough that an
/// in-memory field is simpler and avoids adding a network round trip to what both endpoints
/// already are: plain HTTP reads. <see cref="TimeProvider"/> is injected (rather than
/// <see cref="DateTimeOffset.UtcNow"/>) so tests can advance the clock deterministically
/// instead of sleeping past the real TTL.
/// </summary>
internal sealed class HelixCaches(TimeProvider timeProvider)
{
  public static readonly TimeSpan StreamStatusTtl = TimeSpan.FromSeconds(15);
  public static readonly TimeSpan AdScheduleTtl = TimeSpan.FromSeconds(5);

  private readonly Lock _lock = new();
  private (DateTimeOffset ExpiresAt, HelixStreamStatus Value)? _streamStatus;
  private (DateTimeOffset ExpiresAt, HelixAdSchedule Value)? _adSchedule;

  public bool TryGetStreamStatus(out HelixStreamStatus value)
  {
    lock (_lock)
    {
      if (_streamStatus is { } cached && cached.ExpiresAt > timeProvider.GetUtcNow())
      {
        value = cached.Value;
        return true;
      }
    }

    value = new HelixStreamStatus();
    return false;
  }

  public void SetStreamStatus(HelixStreamStatus value)
  {
    lock (_lock)
    {
      _streamStatus = (timeProvider.GetUtcNow() + StreamStatusTtl, value);
    }
  }

  public bool TryGetAdSchedule(out HelixAdSchedule value)
  {
    lock (_lock)
    {
      if (_adSchedule is { } cached && cached.ExpiresAt > timeProvider.GetUtcNow())
      {
        value = cached.Value;
        return true;
      }
    }

    value = new HelixAdSchedule();
    return false;
  }

  public void SetAdSchedule(HelixAdSchedule value)
  {
    lock (_lock)
    {
      _adSchedule = (timeProvider.GetUtcNow() + AdScheduleTtl, value);
    }
  }

  /// <summary>
  /// Drops both cached responses. Called only from <see cref="HelixClient.InvalidateAsync"/>:
  /// these entries describe a SPECIFIC broadcaster's stream and ad schedule, so once the
  /// broadcaster changes they are not merely stale, they are about the wrong channel — and
  /// their TTLs (15s/5s) would otherwise keep serving that wrong channel's answers to the
  /// dashboard for a few seconds after the switch.
  /// </summary>
  public void Clear()
  {
    lock (_lock)
    {
      _streamStatus = null;
      _adSchedule = null;
    }
  }
}
