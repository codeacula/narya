using MediatR;

using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using Narya.Application.AppConfig.Notifications;
using Narya.Application.Realtime;
using Narya.Core.AppConfig;
using Narya.Core.Realtime;

namespace Narya.Application.Tests.Realtime;

/// <summary>
/// Proves the composition root (<c>AddNaryaApplication</c>) wires exactly one
/// <c>RealtimeBridgeHandler&lt;T&gt;</c> per realtime notification type.
/// <c>RealtimeBridgeHandler&lt;T&gt;</c> is registered EXCLUSIVELY by MediatR's
/// <c>RegisterServicesFromAssemblyContaining&lt;NaryaApplication&gt;</c> assembly scan —
/// <see cref="ServiceCollectionExtensions.AddNaryaApplication"/> does NOT also register it
/// explicitly (there is no <c>AddTransient(typeof(INotificationHandler&lt;&gt;), ...)</c>
/// call anywhere in that method). <c>ResolvesExactlyOneHandlerForARealtimeNotificationType</c>
/// is the guard: if a future change added an explicit registration alongside the assembly
/// scan (mistaking the scan for the ONLY thing needing fixing, rather than the thing already
/// doing the job), MediatR would invoke both handler instances on every <c>Publish</c> and
/// silently double-publish every realtime event to Redis.
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

  /// <summary>
  /// Locks in the fix for the review finding that a Redis outage during
  /// <c>RealtimeBridgeHandler{T}.Handle</c> would propagate out of
  /// <c>UpdateAppConfigCommandHandler</c>'s <c>mediator.Publish</c> call — which runs
  /// AFTER the config write already committed — turning an already-succeeded save into a
  /// 500 the operator would be tempted to retry, duplicating the write. Realtime delivery
  /// is best-effort by design: a transport failure must be logged, not thrown.
  /// </summary>
  [Fact]
  public async Task HandleSwallowsAPublishFailureAndLogsItRatherThanThrowing()
  {
    var publisher = Substitute.For<IRealtimePublisher>();
    _ = publisher
      .PublishAsync(Arg.Any<string>(), Arg.Any<object>(), Arg.Any<CancellationToken>())
      .Returns(Task.FromException(new InvalidOperationException("redis unreachable")));
    var logger = new RecordingLogger<RealtimeBridgeHandler<AppConfigUpdatedNotification>>();
    var handler = new RealtimeBridgeHandler<AppConfigUpdatedNotification>(publisher, logger);
    var notification = new AppConfigUpdatedNotification(new AppConfigResponse { TwitchChannel = "codeacula" });

    var exception = await Record.ExceptionAsync(() => handler.Handle(notification, CancellationToken.None));

    Assert.Null(exception);
    Assert.True(logger.WasWarningLogged, "Expected the transport failure to be logged.");
  }

  /// <summary>
  /// Real cancellation (as opposed to a transport failure) must still propagate rather
  /// than being swallowed as if it were a best-effort delivery failure.
  /// </summary>
  [Fact]
  public async Task HandlePropagatesGenuineCancellationRatherThanSwallowingIt()
  {
    var publisher = Substitute.For<IRealtimePublisher>();
    using var cts = new CancellationTokenSource();
    _ = publisher
      .PublishAsync(Arg.Any<string>(), Arg.Any<object>(), Arg.Any<CancellationToken>())
      .Returns(_ =>
      {
        cts.Cancel();
        return Task.FromCanceled(cts.Token);
      });
    var handler = new RealtimeBridgeHandler<AppConfigUpdatedNotification>(publisher, NullLogger<RealtimeBridgeHandler<AppConfigUpdatedNotification>>.Instance);
    var notification = new AppConfigUpdatedNotification(new AppConfigResponse { TwitchChannel = "codeacula" });

    _ = await Assert.ThrowsAsync<TaskCanceledException>(() => handler.Handle(notification, cts.Token));
  }

  private sealed class RecordingLogger<TCategory> : ILogger<TCategory>
  {
    public bool WasWarningLogged { get; private set; }

    public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

    public bool IsEnabled(LogLevel logLevel) => true;

    public void Log<TState>(
      LogLevel logLevel, EventId eventId, TState state, Exception? exception,
      Func<TState, Exception?, string> formatter)
    {
      if (logLevel == LogLevel.Warning)
      {
        WasWarningLogged = true;
      }
    }
  }
}
