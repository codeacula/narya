using NSubstitute;

using Narya.Application.Viewers;
using Narya.Core.Viewers;

namespace Narya.Application.Tests.Viewers;

public sealed class GetRecentViewersQueryTests
{
  private sealed class FixedTimeProvider(DateTimeOffset now) : TimeProvider
  {
    public override DateTimeOffset GetUtcNow() => now;
  }

  [Fact]
  public async Task StampsAgoOnEveryRecentMessageFromNow()
  {
    var store = Substitute.For<IViewerStore>();
    var now = DateTimeOffset.Parse("2026-07-17T12:05:00Z", System.Globalization.CultureInfo.InvariantCulture);
    var viewers = new Dictionary<string, Viewer>
    {
      ["viewer"] = new Viewer(
        Display: "Viewer", Color: "#111111", Roles: ["sub"], Followed: "not available",
        Subbed: "subscriber badge present", AccountAge: "not available",
        Recent:
        [
          new ViewerRecentMessage("hello", now.AddMinutes(-5), null),
        ]),
    };
    _ = store.GetRecentViewersAsync(500, Arg.Any<CancellationToken>()).Returns(viewers);
    var handler = new GetRecentViewersQueryHandler(store, new FixedTimeProvider(now));

    var result = await handler.Handle(new GetRecentViewersQuery(), CancellationToken.None);

    var viewer = Assert.Single(result).Value;
    var message = Assert.Single(viewer.Recent);
    Assert.Equal("5:00", message.Ago);
    Assert.Equal("hello", message.Text);
  }

  [Fact]
  public async Task RequestsTheLegacyFiveHundredMessageScanLimit()
  {
    var store = Substitute.For<IViewerStore>();
    _ = store.GetRecentViewersAsync(Arg.Any<int>(), Arg.Any<CancellationToken>())
      .Returns(new Dictionary<string, Viewer>());
    var handler = new GetRecentViewersQueryHandler(store, new FixedTimeProvider(DateTimeOffset.UtcNow));

    _ = await handler.Handle(new GetRecentViewersQuery(), CancellationToken.None);

    _ = await store.Received(1).GetRecentViewersAsync(500, Arg.Any<CancellationToken>());
  }
}
