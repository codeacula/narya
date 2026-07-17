using Narya.Core.Realtime;

namespace Narya.Api.Realtime;

/// <summary>
/// The pure routing decision <see cref="RealtimeBroadcastService"/> forwards each Redis
/// envelope through: which SignalR groups should receive a given event name. Extracted
/// out of the background service so the rule (operator group always; overlay group only
/// when allowlisted) is unit-testable without standing up a live hub connection.
/// </summary>
public static class RealtimeRouting
{
  /// <summary>
  /// The operator group always receives every event. The overlay group is appended only
  /// when <paramref name="eventName"/> is in <see cref="RealtimeEventNames.OverlayAllowlist"/>
  /// — see that allowlist's remarks for why it starts empty in Phase 1.
  /// </summary>
  public static IReadOnlyList<string> GroupsFor(string eventName) =>
    GroupsFor(eventName, RealtimeEventNames.OverlayAllowlist);

  /// <summary>
  /// Allowlist-parameterized overload so the routing rule itself — not just today's
  /// (empty) allowlist contents — is testable: <see cref="RealtimeEventNames.OverlayAllowlist"/>
  /// is a fixed, shared static field with nothing in it yet in Phase 1, so this is the
  /// only way to exercise the "event IS allowlisted → both groups" branch without
  /// mutating shared process-wide state from a test.
  /// </summary>
  public static IReadOnlyList<string> GroupsFor(string eventName, IReadOnlySet<string> overlayAllowlist) =>
    overlayAllowlist.Contains(eventName)
      ? [RealtimeHub.OperatorGroup, RealtimeHub.OverlayGroup]
      : [RealtimeHub.OperatorGroup];
}
