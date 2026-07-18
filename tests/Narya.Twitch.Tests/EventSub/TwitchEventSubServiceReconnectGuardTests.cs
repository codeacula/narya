using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using Narya.Twitch.EventSub;
using Narya.Twitch.Helix;

using TwitchLib.EventSub.Websockets;

namespace Narya.Twitch.Tests.EventSub;

/// <summary>
/// Exercises the reentrancy guard <see cref="TwitchEventSubService.ReconnectWithBackoffAsync"/>
/// takes on <see cref="TwitchEventSubService._reconnecting"/> (an <c>int</c> CompareExchange
/// latch). <see cref="TwitchEventSubService.OnWebsocketDisconnectedAsync"/> fires this
/// fire-and-forget on every <c>WebsocketDisconnected</c>, with no guard before this fix — a
/// second spurious disconnect (TwitchLib's "Failed Ping/Pong" behavior, twitchlib-spec.md §5
/// gotcha #10) while a backoff loop is already retrying would spawn a second concurrent loop,
/// each of which could independently land a session and re-subscribe, double-firing every
/// redemption/chat/alert.
///
/// The real <see cref="EventSubWebsocketClient"/> has no virtual members, so it cannot be
/// substituted to directly count how many loops call <c>ReconnectAsync</c> (and calling the
/// real method would attempt an actual network connection to Twitch — exactly what
/// <c>ServiceCollectionExtensionsTests</c> and the rest of this suite deliberately never do).
/// Instead these tests drive <c>_reconnecting</c> directly (accessible via the assembly's
/// existing <c>InternalsVisibleTo("Narya.Twitch.Tests")</c>) to prove the guard's two halves:
/// a held guard makes a call a same-thread no-op, and a released guard lets a later call proceed.
/// </summary>
public sealed class TwitchEventSubServiceReconnectGuardTests
{
  private static TwitchEventSubService BuildService() => new(
    new EventSubWebsocketClient(),
    Substitute.For<IHelixClient>(),
    TimeProvider.System,
    NullLogger<TwitchEventSubService>.Instance);

  [Fact]
  public async Task ReconnectWithBackoffIsANoOpWhileAnotherLoopIsAlreadyInFlight()
  {
    var service = BuildService();

    // Simulate a first loop already owning the guard (as it would while blocked inside
    // _client.ReconnectAsync() or its backoff Task.Delay).
    service._reconnecting = 1;

    var task = service.ReconnectWithBackoffAsync(CancellationToken.None);
    var completed = await Task.WhenAny(task, Task.Delay(TimeSpan.FromSeconds(2))) == task;

    Assert.True(completed, "A reentrant call should return immediately instead of blocking on the real client.");

    // The reentrant call must not touch the guard at all — only the (still notionally
    // in-flight) first loop's own `finally` is allowed to release it. If the second call had
    // run the loop body, it would have reset this to 0 in its own `finally`.
    Assert.Equal(1, service._reconnecting);
  }

  [Fact]
  public async Task ReconnectWithBackoffReleasesTheGuardOnCompletionSoALaterCallCanAcquireIt()
  {
    var service = BuildService();

    using var cts = new CancellationTokenSource();
    // Pre-cancelled: the loop's very first check (before ever touching _client.ReconnectAsync)
    // returns immediately, letting this test observe a full acquire-then-release cycle without
    // any real network attempt.
    await cts.CancelAsync();

    var task = service.ReconnectWithBackoffAsync(cts.Token);
    var completed = await Task.WhenAny(task, Task.Delay(TimeSpan.FromSeconds(2))) == task;

    Assert.True(completed, "A cancelled-token call should return immediately.");
    Assert.Equal(0, service._reconnecting);

    // Guard released → a subsequent call is free to acquire it again (proven the same way).
    var second = service.ReconnectWithBackoffAsync(cts.Token);
    var secondCompleted = await Task.WhenAny(second, Task.Delay(TimeSpan.FromSeconds(2))) == second;

    Assert.True(secondCompleted);
    Assert.Equal(0, service._reconnecting);
  }
}
