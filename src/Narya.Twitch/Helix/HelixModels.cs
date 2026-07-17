namespace Narya.Twitch.Helix;

/// <summary>A Twitch user, as returned by <c>GET /helix/users</c>.</summary>
public sealed record HelixUser
{
  public required string Id { get; init; }
  public required string Login { get; init; }
}

/// <summary>Channel info as returned by <c>GET /helix/channels</c>.</summary>
public sealed record HelixChannelInfo
{
  public string BroadcasterName { get; init; } = "";
  public string GameId { get; init; } = "";
  public string GameName { get; init; } = "";
  public string Title { get; init; } = "";
  public IReadOnlyList<string> Tags { get; init; } = [];
}

/// <summary>
/// Live-stream status. An empty Twitch <c>streams</c> array (channel offline) maps to the
/// all-null default, which <see cref="IHelixClient.GetStreamStatusAsync"/> treats as "not
/// live" rather than a failure.
/// </summary>
public sealed record HelixStreamStatus
{
  public DateTimeOffset? StartedAt { get; init; }
  public int? ViewerCount { get; init; }
}

/// <summary>
/// Ad schedule as returned by <c>GET /helix/channels/ads</c>. TwitchLib's own
/// <c>AdSchedule</c> model exposes <c>next_ad_at</c>/<c>snooze_refresh_at</c> as raw RFC3339
/// <see cref="string"/>s rather than parsed dates — <see cref="HelixClient"/> parses them into
/// these <see cref="DateTimeOffset"/> fields (null when Twitch sends an empty string, i.e. no
/// ad currently scheduled).
/// </summary>
public sealed record HelixAdSchedule
{
  public DateTimeOffset? NextAdAt { get; init; }
  public int? Duration { get; init; }
  public int? SnoozeCount { get; init; }
  public DateTimeOffset? SnoozeRefreshAt { get; init; }
  public int? PrerollFreeTime { get; init; }
}

/// <summary>A Twitch category/game, as returned by both category search and games-by-id lookups.</summary>
public sealed record HelixCategory
{
  public required string Id { get; init; }
  public required string Name { get; init; }
  public string? BoxArtUrl { get; init; }
}

/// <summary>
/// Result of starting (or joining) a commercial break. TwitchLib's own
/// <c>StartCommercialResponse</c> exposes these fields directly (it is NOT wrapped in a
/// <c>Data[]</c> array the way most other Helix responses are) — see the Phase 2 Task 4 report
/// for this deviation from the original TwitchLib migration spec.
/// </summary>
public sealed record HelixCommercialResult
{
  public int Length { get; init; }
  public string? Message { get; init; }
  public int? RetryAfter { get; init; }
}

/// <summary>
/// Outcome of <see cref="IHelixClient.ResolveAutomodMessageAsync"/>. <see cref="AutomodOutcomes.Gone"/>
/// means Twitch no longer holds the message (already expired, or resolved elsewhere) — the
/// caller treats that the same as a successful resolution, not an error.
/// </summary>
public sealed record AutomodResolution
{
  public required string Outcome { get; init; }
}

public static class AutomodOutcomes
{
  public const string Ok = "ok";
  public const string Gone = "gone";
}
