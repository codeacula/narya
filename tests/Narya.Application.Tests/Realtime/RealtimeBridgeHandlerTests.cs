using MediatR;

using Microsoft.Extensions.DependencyInjection;

using NSubstitute;

using Narya.Application.AppConfig.Notifications;
using Narya.Core.AppConfig;
using Narya.Core.Realtime;

namespace Narya.Application.Tests.Realtime;

/// <summary>
/// Proves the composition root (<c>AddNaryaApplication</c>) wires exactly one
/// <c>RealtimeBridgeHandler&lt;T&gt;</c> per realtime notification type. This is the load
/// -bearing assertion for the open-generic registration: <c>RealtimeBridgeHandlerTests
/// .PublishesThroughTheBridgeExactlyOnce</c> would fail with 2 calls if MediatR's assembly
/// scan ALSO auto-discovers the constrained open generic handler in addition to the
/// explicit <c>AddTransient(typeof(INotificationHandler&lt;&gt;), ...)</c> registration in
/// <see cref="ServiceCollectionExtensions.AddNaryaApplication"/> — a duplicate
/// registration would silently double-publish every realtime event to Redis.
/// </summary>
public sealed class RealtimeBridgeHandlerTests
{
  [Fact]
  public async Task PublishesThroughTheBridgeExactlyOnce()
  {
    var publisher = Substitute.For<IRealtimePublisher>();
    var services = new ServiceCollection();
    _ = services.AddLogging();
    _ = services.AddNaryaApplication();
    _ = services.AddSingleton(publisher);

    await using var provider = services.BuildServiceProvider();
    var mediator = provider.GetRequiredService<IMediator>();
    var response = new AppConfigResponse { TwitchChannel = "codeacula" };

    await mediator.Publish(new AppConfigUpdatedNotification(response), CancellationToken.None);

    await publisher.Received(1).PublishAsync("settings:updated", response, Arg.Any<CancellationToken>());
  }

  [Fact]
  public void ResolvesExactlyOneHandlerForARealtimeNotificationType()
  {
    var services = new ServiceCollection();
    _ = services.AddLogging();
    _ = services.AddNaryaApplication();
    _ = services.AddSingleton(Substitute.For<IRealtimePublisher>());

    using var provider = services.BuildServiceProvider();
    var handlers = provider.GetServices<INotificationHandler<AppConfigUpdatedNotification>>();

    _ = Assert.Single(handlers);
  }
}
