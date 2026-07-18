using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;
using NSubstitute.ExceptionExtensions;

using Narya.Api.Automation;
using Narya.Core.Automation;

namespace Narya.Api.Tests.Automation;

/// <summary>
/// Exercises <see cref="AutomationRunPruneService.TickAsync"/> directly — same shape as
/// <c>DashboardHeartbeatServiceTests</c>: the <see cref="PeriodicTimer"/> loop in
/// <c>ExecuteAsync</c> (including the immediate boot tick before the loop) is integration-only and
/// not covered here.
/// </summary>
public sealed class AutomationRunPruneServiceTests
{
  private sealed record Fixture(AutomationRunPruneService Service, IAutomationRunStore RunStore, TimeProvider TimeProvider);

  private static Fixture Build()
  {
    var runStore = Substitute.For<IAutomationRunStore>();
    var serviceProvider = Substitute.For<IServiceProvider>();
    _ = serviceProvider.GetService(typeof(IAutomationRunStore)).Returns(runStore);
    var scope = Substitute.For<IServiceScope>();
    _ = scope.ServiceProvider.Returns(serviceProvider);
    var scopeFactory = Substitute.For<IServiceScopeFactory>();
    _ = scopeFactory.CreateScope().Returns(scope);

    var timeProvider = TimeProvider.System;
    var service = new AutomationRunPruneService(scopeFactory, timeProvider, NullLogger<AutomationRunPruneService>.Instance);

    return new Fixture(service, runStore, timeProvider);
  }

  [Fact]
  public async Task TickPrunesWithACutoffOfNowMinusTheRetentionWindow()
  {
    var f = Build();
    _ = f.RunStore.PruneAsync(Arg.Any<DateTimeOffset>(), Arg.Any<CancellationToken>()).Returns(0);

    await f.Service.TickAsync(CancellationToken.None);

    var expectedCutoff = f.TimeProvider.GetUtcNow() - AutomationRunPruneService.RunRetention;
    _ = await f.RunStore.Received(1).PruneAsync(
      Arg.Is<DateTimeOffset>(cutoff => Math.Abs((cutoff - expectedCutoff).TotalSeconds) < 5), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task TickSwallowsAFailureRatherThanThrowing()
  {
    var f = Build();
    _ = f.RunStore.PruneAsync(Arg.Any<DateTimeOffset>(), Arg.Any<CancellationToken>())
      .ThrowsAsync(new InvalidOperationException("boom"));

    // Must not throw — a transient database failure must never take the whole prune loop (and
    // every future tick) down.
    var exception = await Record.ExceptionAsync(() => f.Service.TickAsync(CancellationToken.None));

    Assert.Null(exception);
  }

  [Fact]
  public async Task TickDoesNotThrowWhenNothingWasPruned()
  {
    var f = Build();
    _ = f.RunStore.PruneAsync(Arg.Any<DateTimeOffset>(), Arg.Any<CancellationToken>()).Returns(0);

    var exception = await Record.ExceptionAsync(() => f.Service.TickAsync(CancellationToken.None));

    Assert.Null(exception);
  }

  [Fact]
  public void RunRetentionIsSevenDays() => Assert.Equal(TimeSpan.FromDays(7), AutomationRunPruneService.RunRetention);
}
