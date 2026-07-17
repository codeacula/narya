namespace Narya.Twitch.EventSub;

/// <summary>
/// A point-in-time snapshot of <see cref="TwitchEventSubService"/>'s connection state,
/// exposed via <see cref="TwitchEventSubService.Status"/> for a future dashboard/status
/// endpoint (no consumer yet in Phase 2 — this is scaffolding). Deliberately not folded into
/// <see cref="ITwitchEventSource"/>: that interface is the OAuth callback/sign-out routes'
/// narrow command port (start/stop/reconnect), and <see cref="NoopTwitchEventSource"/> has no
/// meaningful connection state to report.
/// </summary>
public sealed record EventSubStatus
{
  public required bool Connected { get; init; }

  public string? SessionId { get; init; }

  public string? LastError { get; init; }

  public int SubscriptionsCreated { get; init; }

  /// <summary>The state before the first connect attempt has resolved.</summary>
  public static readonly EventSubStatus Initial = new() { Connected = false };
}
