namespace Narya.Core.Dashboard;

/// <summary>
/// The dashboard's heartbeat snapshot — a port of legacy's <c>DashboardStatus</c>
/// (<c>legacy/src/shared/api.ts</c>), returned by both <c>GET /api/dashboard/status</c> (REST
/// seed) and the <c>dashboard:status</c> realtime broadcast (<c>Narya.Api.Dashboard.DashboardHeartbeatService</c>)
/// — the REST and WebSocket shapes are identical on purpose, so a client never has to reconcile
/// two different projections of the same status.
///
/// Built by <c>Narya.Application.Dashboard.GetDashboardStatusQueryHandler</c>. Field set matches
/// legacy exactly so the client contract holds, but not every field is LIVE yet in Phase 3:
///
/// <list type="bullet">
/// <item><b>Persistence-backed (live):</b> <see cref="ActiveChatters"/>/<see cref="SessionChatters"/>/
/// <see cref="KnownChatters"/>/<see cref="StreamSessionId"/>/<see cref="StreamSessionStartedAt"/>.</item>
/// <item><b>Twitch auth/EventSub (live):</b> every <c>Twitch*</c>/<c>TwitchBot*</c> field and
/// <see cref="EventSubConnected"/>/<see cref="EventSubError"/>, from Phase 2's
/// <c>Narya.Core.Dashboard.IDashboardTwitchStatusProvider</c>. <see cref="EventSubFailedSubscriptions"/>
/// is always empty for now — Phase 2's <c>EventSubStatus</c> tracks only a single
/// <c>LastError</c> string, not a per-subscription-type failure list; a later phase can extend
/// that shape if per-type detail becomes worth surfacing.</item>
/// <item><b>Config (live):</b> <see cref="Channel"/>, from <c>IAppConfigStore</c>.</item>
/// <item><b><see cref="ChatConnection"/> (approximated):</b> legacy derived this from a separate
/// tmi.js IRC client's ready-state. Narya's Phase 2 port moved chat ingestion onto the same
/// EventSub WebSocket as everything else (twitchlib-spec.md), so there is no second connection
/// to report on — this mirrors <see cref="EventSubConnected"/> (<c>"OPEN"</c>/<c>"CLOSED"</c>)
/// rather than legacy's independent IRC state.</item>
/// <item><b>OBS/ad-schedule/stream-live (deferred — Phase 8):</b> everything from
/// <see cref="ObsConnected"/> through <see cref="SnoozeRefreshAt"/> below. Defaulted to
/// <see langword="null"/>/<see langword="false"/>/<c>0</c> so the wire shape matches legacy today;
/// a later phase fills them in without another shape change.</item>
/// </list>
/// </summary>
public sealed record DashboardStatus
{
  public required string Channel { get; init; }

  /// <summary>One of <c>"CONNECTING"</c>/<c>"OPEN"</c>/<c>"CLOSING"</c>/<c>"CLOSED"</c>/<c>"UNKNOWN"</c> — see the class doc comment.</summary>
  public required string ChatConnection { get; init; }

  /// <summary>Deferred to Phase 8 (OBS) — always <see langword="false"/> for now.</summary>
  public bool ObsConnected { get; init; }

  public required bool EventSubConnected { get; init; }

  public string? EventSubError { get; init; }

  public IReadOnlyList<string> EventSubFailedSubscriptions { get; init; } = [];

  public required bool TwitchAuthenticated { get; init; }

  /// <summary><c>"oauth"</c> or <see langword="null"/> — matches legacy's narrower union (OAuth is the only source Narya supports).</summary>
  public string? TwitchAuthSource { get; init; }

  public DateTimeOffset? TwitchTokenExpiresAt { get; init; }

  public required IReadOnlyList<string> TwitchMissingScopes { get; init; }

  public required bool TwitchBotAuthenticated { get; init; }

  public string? TwitchBotAuthSource { get; init; }

  public DateTimeOffset? TwitchBotTokenExpiresAt { get; init; }

  public required IReadOnlyList<string> TwitchBotMissingScopes { get; init; }

  /// <summary>Deferred to Phase 8 (Twitch/OBS stream-live status) — always <see langword="null"/> for now.</summary>
  public bool? StreamActive { get; init; }

  public int? UptimeSeconds { get; init; }

  public DateTimeOffset? StreamStartedAt { get; init; }

  /// <summary><c>"twitch"</c>/<c>"obs"</c>/<see langword="null"/>.</summary>
  public string? UptimeSource { get; init; }

  public int? ViewerCount { get; init; }

  /// <summary>Distinct chat usernames seen in the last 15 minutes.</summary>
  public required int ActiveChatters { get; init; }

  /// <summary>Distinct chatters recorded against the current stream session (0 off-stream).</summary>
  public required int SessionChatters { get; init; }

  /// <summary>Total distinct chatters ever seen (the <c>chatters</c> table's row count).</summary>
  public required int KnownChatters { get; init; }

  public string? StreamSessionId { get; init; }

  public DateTimeOffset? StreamSessionStartedAt { get; init; }

  /// <summary>Deferred to Phase 8 (OBS stats) — always <see langword="null"/> for now.</summary>
  public int? BitrateKbps { get; init; }

  public int? Congestion { get; init; }

  public int? TotalFrames { get; init; }

  public int? DroppedFrames { get; init; }

  public int? LaggedFrames { get; init; }

  /// <summary>Deferred to Phase 8 (Twitch ad schedule) — always <see langword="null"/> for now.</summary>
  public DateTimeOffset? AdBreakEndsAt { get; init; }

  /// <summary><c>"available"</c>/<c>"not_configured"</c>/<c>"missing_scope"</c>/<c>"unauthorized"</c>/<c>"unavailable"</c>/<see langword="null"/>.</summary>
  public string? AdScheduleStatus { get; init; }

  public string? AdScheduleError { get; init; }

  public DateTimeOffset? NextAdAt { get; init; }

  public DateTimeOffset? LastAdAt { get; init; }

  public int? AdBreakDurationSeconds { get; init; }

  public int? PrerollFreeTimeSeconds { get; init; }

  public int? SnoozeCount { get; init; }

  public DateTimeOffset? SnoozeRefreshAt { get; init; }
}
