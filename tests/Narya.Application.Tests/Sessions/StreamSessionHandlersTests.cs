using NSubstitute;

using Narya.Application.Sessions;
using Narya.Core.Sessions;

namespace Narya.Application.Tests.Sessions;

public sealed class StreamOnlineHandlerTests
{
  [Fact]
  public async Task StartsASessionKeyedByTheTwitchStreamId()
  {
    var store = Substitute.For<IStreamSessionStore>();
    var startedAt = DateTimeOffset.UtcNow;
    _ = store.GetOrStartSessionAsync(Arg.Any<string>(), Arg.Any<DateTimeOffset>(), Arg.Any<CancellationToken>())
      .Returns(new StreamSession("session-1", startedAt, null, "twitch:stream-1", null, null, null, 0, false));
    var handler = new StreamOnlineHandler(store);

    await handler.Handle(new StreamOnlineNotification("stream-1", startedAt), CancellationToken.None);

    _ = await store.Received(1).GetOrStartSessionAsync("twitch:stream-1", startedAt, Arg.Any<CancellationToken>());
  }
}

public sealed class StreamOfflineHandlerTests
{
  private sealed class FixedTimeProvider(DateTimeOffset now) : TimeProvider
  {
    public override DateTimeOffset GetUtcNow() => now;
  }

  [Fact]
  public async Task EndsTheActiveSessionUsingTheClock()
  {
    var store = Substitute.For<IStreamSessionStore>();
    var now = DateTimeOffset.UtcNow;
    var handler = new StreamOfflineHandler(store, new FixedTimeProvider(now));

    await handler.Handle(new StreamOfflineNotification(), CancellationToken.None);

    await store.Received(1).EndActiveSessionAsync(now, Arg.Any<CancellationToken>());
  }
}
