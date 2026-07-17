using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Logging;

using NSubstitute;

using StackExchange.Redis;

using Narya.Api.Realtime;

namespace Narya.Api.Tests.Realtime;

/// <summary>
/// Covers the fix for the review finding that <see cref="RealtimeBroadcastService.HandleMessageAsync"/>
/// only guarded JSON deserialization with try/catch, leaving the subsequent
/// <c>hubContext.Clients.Group(...).SendAsync(...)</c> calls unguarded. Any exception there
/// (a transient SignalR/transport failure, for instance) would propagate out of
/// <c>ExecuteAsync</c>'s <c>await foreach</c> loop and, under <see cref="BackgroundService"/>'s
/// default <c>BackgroundServiceExceptionBehavior.StopHost</c>, stop the entire <c>IHost</c> —
/// every endpoint, not just realtime — over a single unforwardable message.
///
/// These tests substitute <see cref="IHubContext{RealtimeHub}"/> so a group send throws, and
/// assert <c>HandleMessageAsync</c> swallows the failure (logs, doesn't throw) and keeps
/// processing subsequent messages.
/// </summary>
public sealed class RealtimeBroadcastServiceTests
{
  private const string WellFormedEnvelopeJson =
    """{"event":"settings:updated","payload":{"twitchChannel":"codeacula"}}""";

  private static (RealtimeBroadcastService Service, IClientProxy ClientProxy) BuildService()
  {
    var clientProxy = Substitute.For<IClientProxy>();

    var hubClients = Substitute.For<IHubClients>();
    _ = hubClients.Group(Arg.Any<string>()).Returns(clientProxy);

    var hubContext = Substitute.For<IHubContext<RealtimeHub>>();
    _ = hubContext.Clients.Returns(hubClients);

    var multiplexer = Substitute.For<IConnectionMultiplexer>();
    var logger = Substitute.For<ILogger<RealtimeBroadcastService>>();

    var service = new RealtimeBroadcastService(multiplexer, hubContext, logger);
    return (service, clientProxy);
  }

  [Fact]
  public async Task GroupSendFailureIsSwallowedNotThrown()
  {
    var (service, clientProxy) = BuildService();
    _ = clientProxy
      .SendCoreAsync(Arg.Any<string>(), Arg.Any<object?[]>(), Arg.Any<CancellationToken>())
      .Returns(Task.FromException(new InvalidOperationException("transport failure")));

    var exception = await Record.ExceptionAsync(
      () => service.HandleMessageAsync(WellFormedEnvelopeJson, CancellationToken.None));

    Assert.Null(exception);
  }

  [Fact]
  public async Task ServiceKeepsProcessingAfterAPriorMessageFailedToForward()
  {
    var (service, clientProxy) = BuildService();

    // First call throws (simulating the transient SignalR/transport failure); the second
    // succeeds — proves the handler (and by extension the ExecuteAsync loop that invokes
    // it per message) survives the first failure and still forwards the next message.
    _ = clientProxy
      .SendCoreAsync(Arg.Any<string>(), Arg.Any<object?[]>(), Arg.Any<CancellationToken>())
      .Returns(
        Task.FromException(new InvalidOperationException("transport failure")),
        Task.CompletedTask);

    await service.HandleMessageAsync(WellFormedEnvelopeJson, CancellationToken.None);
    await service.HandleMessageAsync(WellFormedEnvelopeJson, CancellationToken.None);

    await clientProxy.Received(2).SendCoreAsync(
      "event",
      Arg.Is<object?[]>(args => args.Length == 2 && (string)args[0]! == "settings:updated"),
      Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task MalformedJsonIsHandledWithoutThrowing()
  {
    var (service, clientProxy) = BuildService();

    var exception = await Record.ExceptionAsync(
      () => service.HandleMessageAsync("{ this is not valid json", CancellationToken.None));

    Assert.Null(exception);
    await clientProxy.DidNotReceive().SendCoreAsync(
      Arg.Any<string>(), Arg.Any<object?[]>(), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task EmptyMessageIsANoOp()
  {
    var (service, clientProxy) = BuildService();

    var exception = await Record.ExceptionAsync(
      () => service.HandleMessageAsync(string.Empty, CancellationToken.None));

    Assert.Null(exception);
    await clientProxy.DidNotReceive().SendCoreAsync(
      Arg.Any<string>(), Arg.Any<object?[]>(), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task CancellationDuringShutdownPropagatesRatherThanBeingSwallowed()
  {
    var (service, clientProxy) = BuildService();
    using var cts = new CancellationTokenSource();

    _ = clientProxy
      .SendCoreAsync(Arg.Any<string>(), Arg.Any<object?[]>(), Arg.Any<CancellationToken>())
      .Returns(_ =>
      {
        cts.Cancel();
        return Task.FromCanceled(cts.Token);
      });

    _ = await Assert.ThrowsAsync<TaskCanceledException>(
      () => service.HandleMessageAsync(WellFormedEnvelopeJson, cts.Token));
  }
}
