using Narya.Api.Realtime;
using Narya.Core.Realtime;

namespace Narya.Api.Tests.Realtime;

/// <summary>
/// <see cref="RealtimeRouting.GroupsFor"/> is the pure decision
/// <see cref="RealtimeBroadcastService"/> forwards each Redis envelope through — extracted
/// specifically so the operator/overlay routing rule is testable without a live SignalR
/// hub connection or a Redis subscription. <see cref="Narya.Core.Realtime.RealtimeEventNames.OverlayAllowlist"/>
/// was empty in Phase 1, so every real event routed to the operator group only; Phase 2 Task 6
/// populates it with the four EventSub-sourced events an overlay actually renders
/// (<c>chat:message</c>, <c>chat:moderated</c>, <c>stream:event</c>, <c>stream:event:update</c>),
/// so the tests below exercise the zero-arg <see cref="RealtimeRouting.GroupsFor(string)"/>
/// overload against the REAL, now-nonempty allowlist rather than only a hypothetical one.
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

  [Theory]
  [InlineData("chat:message")]
  [InlineData("chat:moderated")]
  [InlineData("stream:event")]
  [InlineData("stream:event:update")]
  public void EventSubSourcedEventsRouteToBothGroupsAgainstTheRealAllowlist(string eventName)
  {
    var groups = RealtimeRouting.GroupsFor(eventName);

    Assert.Equal([RealtimeHub.OperatorGroup, RealtimeHub.OverlayGroup], groups);
  }

  /// <summary>
  /// A whisper is private correspondence with the operator — it must never reach an overlay
  /// browser source, so it is deliberately absent from
  /// <see cref="RealtimeEventNames.OverlayAllowlist"/> even though the other four Task 6 events
  /// are present.
  /// </summary>
  [Fact]
  public void WhisperMessageRoutesToTheOperatorGroupOnlyAgainstTheRealAllowlist()
  {
    var groups = RealtimeRouting.GroupsFor("whisper:message");

    Assert.Equal([RealtimeHub.OperatorGroup], groups);
  }
}
