using NSubstitute;

using Narya.Application.Events;
using Narya.Core.Events;

namespace Narya.Application.Tests.Events;

public sealed class GetRecentStreamEventsQueryTests
{
  private sealed class FixedTimeProvider(DateTimeOffset now) : TimeProvider
  {
    public override DateTimeOffset GetUtcNow() => now;
  }

  [Fact]
  public async Task ReturnsTheStoresEventsWithAgoComputedFromNow()
  {
    var store = Substitute.For<IStreamEventStore>();
    var now = DateTimeOffset.Parse("2026-07-17T12:05:00Z", System.Globalization.CultureInfo.InvariantCulture);
    IReadOnlyList<StreamEvent> events =
    [
      new StreamEvent(
        Id: "event-1", Kind: "follow", Actor: "Viewer", Detail: "followed", Tone: "silver",
        ReceivedAt: now.AddMinutes(-5), SessionId: "session-1"),
    ];
    _ = store.GetRecentAsync(50, Arg.Any<CancellationToken>()).Returns(events);
    var handler = new GetRecentStreamEventsQueryHandler(store, new FixedTimeProvider(now));

    var result = await handler.Handle(new GetRecentStreamEventsQuery(), CancellationToken.None);

    var mapped = Assert.Single(result);
    Assert.Equal("event-1", mapped.Id);
    Assert.Equal("session-1", mapped.SessionId);
    Assert.Equal("5:00", mapped.Ago);
  }

  [Fact]
  public async Task RequestsTheLegacyFiftyRowLimit()
  {
    var store = Substitute.For<IStreamEventStore>();
    _ = store.GetRecentAsync(Arg.Any<int>(), Arg.Any<CancellationToken>()).Returns([]);
    var handler = new GetRecentStreamEventsQueryHandler(store, new FixedTimeProvider(DateTimeOffset.UtcNow));

    _ = await handler.Handle(new GetRecentStreamEventsQuery(), CancellationToken.None);

    _ = await store.Received(1).GetRecentAsync(50, Arg.Any<CancellationToken>());
  }
}
