using MediatR;

using NSubstitute;

using Narya.Application.Automod;
using Narya.Core.Automod;

namespace Narya.Application.Tests.Automod;

public sealed class GetAutomodQueueQueryTests
{
  private static AutomodHold BuildHold(
    string id, DateTimeOffset heldAt, DateTimeOffset? resolvedAt = null, string? resolution = null) => new(
      Id: id, Channel: "codeacula", Username: "viewer", DisplayName: "Viewer", Message: "hi",
      Category: null, Level: null, HeldAt: heldAt, ResolvedAt: resolvedAt, Resolution: resolution);

  [Fact]
  public async Task ReturnsTheStoresQueueWhenNothingWasSwept()
  {
    var store = Substitute.For<IAutomodStore>();
    var mediator = Substitute.For<IMediator>();
    var hold = BuildHold("held-1", DateTimeOffset.UtcNow);
    var queue = new AutomodQueue([hold], []);
    _ = store.SweepExpiredHoldsAsync(Arg.Any<CancellationToken>()).Returns([]);
    _ = store.GetQueueAsync(Arg.Any<CancellationToken>()).Returns(queue);
    var handler = new GetAutomodQueueQueryHandler(store, mediator);

    var result = await handler.Handle(new GetAutomodQueueQuery(), CancellationToken.None);

    Assert.Same(queue, result);
    await mediator.DidNotReceive().Publish(Arg.Any<AutomodResolvedBroadcastNotification>(), Arg.Any<CancellationToken>());
  }

  /// <summary>
  /// Two holds older than the 2-hour window and one fresh hold — the fresh one is never returned
  /// by <see cref="IAutomodStore.SweepExpiredHoldsAsync"/> (it isn't stale), so it must never
  /// trigger a broadcast, while both swept holds must. Also asserts the sweep runs BEFORE the
  /// queue is fetched, matching <c>GetAutomodQueueQueryHandler</c>'s doc comment — a second
  /// operator client relies on this ordering to see the swept holds move out of Pending.
  /// </summary>
  [Fact]
  public async Task SweepsExpiredHoldsFirstAndPublishesResolvedForEachSweptHoldButNotTheFreshOne()
  {
    var store = Substitute.For<IAutomodStore>();
    var mediator = Substitute.For<IMediator>();
    var now = DateTimeOffset.UtcNow;

    var staleA = BuildHold("stale-a", now.AddHours(-3), resolvedAt: now, resolution: "expired");
    var staleB = BuildHold("stale-b", now.AddHours(-2).AddMinutes(-1), resolvedAt: now, resolution: "expired");
    var fresh = BuildHold("fresh-1", now.AddMinutes(-5));

    _ = store.SweepExpiredHoldsAsync(Arg.Any<CancellationToken>())
      .Returns([staleA, staleB]);
    var queue = new AutomodQueue(Pending: [fresh], RecentlyResolved: [staleA, staleB]);
    _ = store.GetQueueAsync(Arg.Any<CancellationToken>()).Returns(queue);
    var handler = new GetAutomodQueueQueryHandler(store, mediator);

    var result = await handler.Handle(new GetAutomodQueueQuery(), CancellationToken.None);

    Assert.Same(queue, result);
    Assert.Contains(result.RecentlyResolved, h => h.Id == "stale-a");
    Assert.Contains(result.RecentlyResolved, h => h.Id == "stale-b");
    Assert.Contains(result.Pending, h => h.Id == "fresh-1");
    Assert.DoesNotContain(result.Pending, h => h.Id is "stale-a" or "stale-b");

    await mediator.Received(1).Publish(
      Arg.Is<AutomodResolvedBroadcastNotification>(n => n.Hold.Id == "stale-a"), Arg.Any<CancellationToken>());
    await mediator.Received(1).Publish(
      Arg.Is<AutomodResolvedBroadcastNotification>(n => n.Hold.Id == "stale-b"), Arg.Any<CancellationToken>());
    await mediator.Received(2).Publish(Arg.Any<AutomodResolvedBroadcastNotification>(), Arg.Any<CancellationToken>());
    await mediator.DidNotReceive().Publish(
      Arg.Is<AutomodResolvedBroadcastNotification>(n => n.Hold.Id == "fresh-1"), Arg.Any<CancellationToken>());

    Received.InOrder(() =>
    {
      _ = store.SweepExpiredHoldsAsync(Arg.Any<CancellationToken>());
      _ = store.GetQueueAsync(Arg.Any<CancellationToken>());
    });
  }
}
