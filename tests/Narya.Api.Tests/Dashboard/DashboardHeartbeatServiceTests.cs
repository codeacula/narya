using MediatR;

using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;
using NSubstitute.ExceptionExtensions;

using Narya.Api.Dashboard;
using Narya.Api.Realtime;
using Narya.Application.Dashboard;
using Narya.Core.Dashboard;

namespace Narya.Api.Tests.Dashboard;

/// <summary>
/// Exercises <see cref="DashboardHeartbeatService.ShouldBroadcast"/> and
/// <see cref="DashboardHeartbeatService.TickAsync"/> directly — the class's own doc comment
/// explains why these are split out of the <see cref="PeriodicTimer"/> loop in
/// <c>ExecuteAsync</c> (integration-only, not covered here). <c>TickAsync</c>/<c>ShouldBroadcast</c>
/// are <c>internal</c>/<see langword="public"/> respectively, resolvable from this test assembly
/// the same way <c>RealtimeBroadcastServiceTests</c> drives <c>HandleMessageAsync</c> directly.
/// </summary>
public sealed class DashboardHeartbeatServiceTests
{
  private sealed record Fixture(DashboardHeartbeatService Service, IMediator Mediator, RealtimeConnectionTracker Tracker);

  private static Fixture Build()
  {
    var mediator = Substitute.For<IMediator>();
    var serviceProvider = Substitute.For<IServiceProvider>();
    _ = serviceProvider.GetService(typeof(IMediator)).Returns(mediator);
    var scope = Substitute.For<IServiceScope>();
    _ = scope.ServiceProvider.Returns(serviceProvider);
    var scopeFactory = Substitute.For<IServiceScopeFactory>();
    _ = scopeFactory.CreateScope().Returns(scope);

    var tracker = new RealtimeConnectionTracker();
    var service = new DashboardHeartbeatService(
      scopeFactory, tracker, TimeProvider.System, NullLogger<DashboardHeartbeatService>.Instance);

    return new Fixture(service, mediator, tracker);
  }

  [Theory]
  [InlineData(0, false)]
  [InlineData(1, true)]
  [InlineData(5, true)]
  public void ShouldBroadcastReflectsWhetherAnyoneIsConnected(int connectionCount, bool expected) =>
    Assert.Equal(expected, DashboardHeartbeatService.ShouldBroadcast(connectionCount));

  [Fact]
  public async Task TickSkipsEntirelyWhenNoClientsAreConnected()
  {
    var f = Build(); // tracker starts at Count == 0

    await f.Service.TickAsync(CancellationToken.None);

    _ = await f.Mediator.DidNotReceive().Send(Arg.Any<GetDashboardStatusQuery>(), Arg.Any<CancellationToken>());
    await f.Mediator.DidNotReceive().Publish(Arg.Any<DashboardStatusBroadcastNotification>(), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task TickBuildsAndBroadcastsTheSnapshotWhenAtLeastOneClientIsConnected()
  {
    var f = Build();
    f.Tracker.Add("conn-1", isOperator: true);
    var status = new DashboardStatus
    {
      Channel = "codeacula",
      ChatConnection = "OPEN",
      EventSubConnected = true,
      TwitchAuthenticated = false,
      TwitchMissingScopes = [],
      TwitchBotAuthenticated = false,
      TwitchBotMissingScopes = [],
      ActiveChatters = 1,
      SessionChatters = 1,
      KnownChatters = 1,
    };
    _ = f.Mediator.Send(Arg.Any<GetDashboardStatusQuery>(), Arg.Any<CancellationToken>()).Returns(status);

    await f.Service.TickAsync(CancellationToken.None);

    _ = await f.Mediator.Received(1).Send(Arg.Any<GetDashboardStatusQuery>(), Arg.Any<CancellationToken>());
    await f.Mediator.Received(1).Publish(
      Arg.Is<DashboardStatusBroadcastNotification>(n => ReferenceEquals(n.Status, status)), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task TickSwallowsAFailureRatherThanThrowing()
  {
    var f = Build();
    f.Tracker.Add("conn-1", isOperator: true);
    _ = f.Mediator.Send(Arg.Any<GetDashboardStatusQuery>(), Arg.Any<CancellationToken>())
      .ThrowsAsync(new InvalidOperationException("boom"));

    // Must not throw — a bad snapshot must not take the heartbeat loop (and every future tick) down.
    await f.Service.TickAsync(CancellationToken.None);

    await f.Mediator.DidNotReceive().Publish(Arg.Any<DashboardStatusBroadcastNotification>(), Arg.Any<CancellationToken>());
  }

  /// <summary>
  /// <c>dashboard:status</c> is operator-only — an overlay browser source connected for the whole
  /// stream must not defeat the "nobody's listening" skip. Before <see cref="RealtimeConnectionTracker.OperatorCount"/>
  /// existed, <see cref="RealtimeConnectionTracker.Count"/> counted both roles, so this exact case
  /// kept the heartbeat awake (a status query plus a broadcast publish every 5 seconds) with zero
  /// receivers who could ever see the result.
  /// </summary>
  [Fact]
  public async Task TickSkipsWhenOnlyOverlayConnectionsArePresent()
  {
    var f = Build();
    f.Tracker.Add("overlay-1", isOperator: false);
    f.Tracker.Add("overlay-2", isOperator: false);

    await f.Service.TickAsync(CancellationToken.None);

    _ = await f.Mediator.DidNotReceive().Send(Arg.Any<GetDashboardStatusQuery>(), Arg.Any<CancellationToken>());
    await f.Mediator.DidNotReceive().Publish(Arg.Any<DashboardStatusBroadcastNotification>(), Arg.Any<CancellationToken>());
  }

  /// <summary>A single operator connection, even alongside overlay connections, is enough to broadcast.</summary>
  [Fact]
  public async Task TickBroadcastsWhenAnOperatorConnectionIsPresentAlongsideOverlayConnections()
  {
    var f = Build();
    f.Tracker.Add("overlay-1", isOperator: false);
    f.Tracker.Add("operator-1", isOperator: true);
    var status = new DashboardStatus
    {
      Channel = "codeacula",
      ChatConnection = "OPEN",
      EventSubConnected = true,
      TwitchAuthenticated = false,
      TwitchMissingScopes = [],
      TwitchBotAuthenticated = false,
      TwitchBotMissingScopes = [],
      ActiveChatters = 1,
      SessionChatters = 1,
      KnownChatters = 1,
    };
    _ = f.Mediator.Send(Arg.Any<GetDashboardStatusQuery>(), Arg.Any<CancellationToken>()).Returns(status);

    await f.Service.TickAsync(CancellationToken.None);

    _ = await f.Mediator.Received(1).Send(Arg.Any<GetDashboardStatusQuery>(), Arg.Any<CancellationToken>());
    await f.Mediator.Received(1).Publish(
      Arg.Is<DashboardStatusBroadcastNotification>(n => ReferenceEquals(n.Status, status)), Arg.Any<CancellationToken>());
  }
}
