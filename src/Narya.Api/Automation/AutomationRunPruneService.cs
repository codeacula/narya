using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

using Narya.Core.Automation;

namespace Narya.Api.Automation;

/// <summary>
/// Prunes <c>automation_runs</c> rows older than <see cref="RunRetention"/>, at boot and every
/// <see cref="Interval"/> after — a port of legacy's <c>pruneAutomationRuns</c>
/// (<c>legacy/src/server/triggerDispatcher.ts</c>). <c>automation_runs</c> is both the invocation
/// log and the dedupe table, so it grows on every chat message/event that matches a trigger —
/// unbounded, it would outgrow the rest of the database on a busy stream. The retention window must
/// comfortably exceed both the longest configurable cooldown (cooldowns are computed FROM this
/// table, so pruning a row inside its window would silently re-arm a trigger) and any realistic
/// EventSub redelivery gap (pruning a dedupe key lets a redelivery fire twice) — Twitch redelivers
/// within minutes, so 7 days is generous for both, matching legacy's <c>RUN_RETENTION_MS</c>.
///
/// <para>
/// Registered <c>AddHostedService&lt;AutomationRunPruneService&gt;</c> in <c>Narya.Api.Program</c>
/// inside the same <c>Narya:SkipInfrastructure</c> guard as
/// <c>Narya.Api.Dashboard.DashboardHeartbeatService</c> — a WebApplicationFactory test never starts
/// this loop, the same way it never opens a live Redis subscription; it needs a live
/// <see cref="IAutomationRunStore"/> from a real Marten composition. Same
/// <see cref="PeriodicTimer"/>/<see cref="TimeProvider"/>/scoped-<see cref="IServiceScopeFactory"/>
/// shape as that service, plus an immediate first tick before entering the timer loop (legacy prunes
/// once at startup, then on the interval).
/// </para>
/// </summary>
public sealed partial class AutomationRunPruneService(
  IServiceScopeFactory scopeFactory, TimeProvider timeProvider, ILogger<AutomationRunPruneService> logger) : BackgroundService
{
  /// <summary>Matches legacy's <c>RUN_RETENTION_MS</c> (7 days).</summary>
  public static readonly TimeSpan RunRetention = TimeSpan.FromDays(7);

  public static readonly TimeSpan Interval = TimeSpan.FromHours(24);

  protected override async Task ExecuteAsync(CancellationToken stoppingToken)
  {
    // An immediate prune at boot, then on the interval — matches legacy, which prunes once at
    // startup before ever scheduling the recurring sweep.
    await TickAsync(stoppingToken).ConfigureAwait(false);

    using var timer = new PeriodicTimer(Interval, timeProvider);
    while (await timer.WaitForNextTickAsync(stoppingToken).ConfigureAwait(false))
    {
      await TickAsync(stoppingToken).ConfigureAwait(false);
    }
  }

  /// <summary>
  /// One prune tick: resolve a fresh <see cref="IAutomationRunStore"/> from a new DI scope (this
  /// service is a singleton, so it must not hold a root-resolved scoped-lifetime dependency across
  /// ticks — same rationale as <c>DashboardHeartbeatService.TickAsync</c>), then delete every row
  /// older than the retention cutoff. Guarded by a single try/catch, same rationale as every other
  /// hosted-service tick in this codebase: a transient database failure must never take the whole
  /// prune loop (and therefore every future tick) down.
  /// </summary>
  internal async Task TickAsync(CancellationToken cancellationToken)
  {
    try
    {
      using var scope = scopeFactory.CreateScope();
      var runStore = scope.ServiceProvider.GetRequiredService<IAutomationRunStore>();
      var cutoff = timeProvider.GetUtcNow() - RunRetention;
      var pruned = await runStore.PruneAsync(cutoff, cancellationToken).ConfigureAwait(false);
      if (pruned > 0)
      {
        LogPruned(logger, pruned);
      }
    }
    catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
    {
      throw;
    }
    catch (Exception ex)
    {
      LogPruneFailed(logger, ex);
    }
  }

  [LoggerMessage(Level = LogLevel.Information, Message = "Pruned {Count} automation_runs rows older than the retention window")]
  private static partial void LogPruned(ILogger logger, int count);

  [LoggerMessage(Level = LogLevel.Error, Message = "automation_runs prune failed")]
  private static partial void LogPruneFailed(ILogger logger, Exception exception);
}
