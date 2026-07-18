using MediatR;

using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

using Narya.Api.Realtime;
using Narya.Application.Dashboard;

namespace Narya.Api.Dashboard;

/// <summary>
/// A port of legacy's <c>startDashboardHeartbeat</c> (<c>legacy/src/server/dashboard/status.ts</c>):
/// every <see cref="Interval"/>, if at least one SignalR client is connected
/// (<see cref="RealtimeConnectionTracker.Count"/> — the port of legacy's <c>getSocketCount()</c>),
/// computes the current <c>DashboardStatus</c> snapshot and broadcasts it as <c>dashboard:status</c>.
/// Registered <c>AddHostedService&lt;DashboardHeartbeatService&gt;</c> in <c>Narya.Api.Program</c>
/// inside the same <c>Narya:SkipInfrastructure</c> guard as <c>AddSignalR</c>/
/// <see cref="Narya.Api.Realtime.RealtimeBroadcastService"/> — a WebApplicationFactory test never
/// starts this loop, the same way it never opens a live Redis subscription.
///
/// <see cref="ShouldBroadcast"/> and <see cref="TickAsync"/> are deliberately split out of
/// <see cref="ExecuteAsync"/>'s timer loop so the "skip when nobody is listening" decision and
/// the per-tick snapshot-and-publish behavior are unit-testable without a live
/// <see cref="PeriodicTimer"/> running on a background thread — only the loop itself
/// (<see cref="ExecuteAsync"/>) is integration-only.
/// </summary>
public sealed partial class DashboardHeartbeatService(
  IServiceScopeFactory scopeFactory,
  RealtimeConnectionTracker connectionTracker,
  TimeProvider timeProvider,
  ILogger<DashboardHeartbeatService> logger) : BackgroundService
{
  /// <summary>Matches legacy's <c>DASHBOARD_HEARTBEAT_MS</c> (<c>legacy/src/shared/constants.ts</c>).</summary>
  public static readonly TimeSpan Interval = TimeSpan.FromMilliseconds(5_000);

  protected override async Task ExecuteAsync(CancellationToken stoppingToken)
  {
    using var timer = new PeriodicTimer(Interval, timeProvider);

    while (await timer.WaitForNextTickAsync(stoppingToken).ConfigureAwait(false))
    {
      await TickAsync(stoppingToken).ConfigureAwait(false);
    }
  }

  /// <summary>Pure decision: broadcast only when somebody could actually receive it — mirrors legacy's <c>if (getSocketCount() === 0) return;</c>.</summary>
  public static bool ShouldBroadcast(int connectionCount) => connectionCount > 0;

  /// <summary>
  /// One heartbeat tick: skip-check, then (if due) resolve a fresh <see cref="IMediator"/> from a
  /// new DI scope — this service is a singleton, so it must not hold a root-resolved
  /// <see cref="IMediator"/> across ticks, same rationale as
  /// <c>Narya.Twitch.EventSub.TwitchEventSubService.PublishNotificationAsync</c> — send the
  /// status query, then publish the broadcast notification.
  ///
  /// The entire body after the skip-check is guarded by a single try/catch, same rationale as
  /// <c>RealtimeBroadcastService.HandleMessageAsync</c>: a transient failure building or
  /// publishing one snapshot must never take the whole heartbeat loop (and therefore every future
  /// tick) down — it logs and waits for the next tick instead, matching legacy's
  /// <c>.catch(error => console.error(...))</c> on the same call.
  /// </summary>
  internal async Task TickAsync(CancellationToken cancellationToken)
  {
    if (!ShouldBroadcast(connectionTracker.Count))
    {
      return;
    }

    try
    {
      using var scope = scopeFactory.CreateScope();
      var mediator = scope.ServiceProvider.GetRequiredService<IMediator>();

      var status = await mediator.Send(new GetDashboardStatusQuery(), cancellationToken).ConfigureAwait(false);
      await mediator.Publish(new DashboardStatusBroadcastNotification(status), cancellationToken).ConfigureAwait(false);
    }
    catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
    {
      throw;
    }
    catch (Exception ex)
    {
      LogHeartbeatFailed(logger, ex);
    }
  }

  [LoggerMessage(Level = LogLevel.Error, Message = "Dashboard heartbeat failed to build or publish a status snapshot")]
  private static partial void LogHeartbeatFailed(ILogger logger, Exception exception);
}
