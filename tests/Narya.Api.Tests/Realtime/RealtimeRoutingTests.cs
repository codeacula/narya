using Narya.Api.Realtime;

namespace Narya.Api.Tests.Realtime;

/// <summary>
/// <see cref="RealtimeRouting.GroupsFor"/> is the pure decision
/// <see cref="RealtimeBroadcastService"/> forwards each Redis envelope through — extracted
/// specifically so the operator/overlay routing rule is testable without a live SignalR
/// hub connection or a Redis subscription. <see cref="Narya.Core.Realtime.RealtimeEventNames.OverlayAllowlist"/>
/// is empty in Phase 1, so every real event today routes to the operator group only; this
/// test also proves the allowlisted branch for whenever the allowlist stops being empty.
/// </summary>
public sealed class RealtimeRoutingTests
{
  [Fact]
  public void NonAllowlistedEventRoutesToOperatorGroupOnly()
  {
    var groups = RealtimeRouting.GroupsFor("settings:updated");

    Assert.Equal([RealtimeHub.OperatorGroup], groups);
  }

  [Fact]
  public void UnknownEventNameAlsoRoutesToOperatorGroupOnly()
  {
    var groups = RealtimeRouting.GroupsFor("some:event:nobody:allowlisted");

    Assert.Equal([RealtimeHub.OperatorGroup], groups);
  }

  [Fact]
  public void AllowlistedEventRoutesToBothGroups()
  {
    var hypotheticalAllowlist = new HashSet<string> { "chat:message" };

    var groups = RealtimeRouting.GroupsFor("chat:message", hypotheticalAllowlist);

    Assert.Equal([RealtimeHub.OperatorGroup, RealtimeHub.OverlayGroup], groups);
  }

  [Fact]
  public void NonAllowlistedEventAgainstANonEmptyAllowlistStillRoutesToOperatorGroupOnly()
  {
    var hypotheticalAllowlist = new HashSet<string> { "chat:message" };

    var groups = RealtimeRouting.GroupsFor("settings:updated", hypotheticalAllowlist);

    Assert.Equal([RealtimeHub.OperatorGroup], groups);
  }
}
