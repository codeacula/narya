using FluentResults;

using MediatR;

using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using Narya.Application.Actions;
using Narya.Application.Automation;
using Narya.Core.Actions;
using Narya.Core.Automation;
using Narya.Core.Media;
using Narya.Twitch;
using Narya.Twitch.Helix;

namespace Narya.Application.Tests.Automation;

/// <summary>
/// Proves <see cref="MediaMuteGate"/> — the REAL <see cref="IMediaMuteGate"/> Phase 4 Task 4 wires
/// in place of <see cref="NoopMediaMuteGate"/> (see <c>Narya.Api</c>'s <c>Program.cs</c>) — actually
/// reflects <see cref="IMediaMuteStore"/>, both in isolation (<see cref="GateDelegatesDirectlyToTheStore"/>/
/// <see cref="GateReflectsStoreStateChangesAcrossCalls"/>) and end-to-end through
/// <see cref="ActionExecutor"/>'s quickDisable check (<see cref="QuickDisableActionIsSkippedWhenTheWiredGatesUnderlyingStoreReportsMuted"/>/
/// <see cref="QuickDisableActionRunsNormallyWhenTheWiredGatesUnderlyingStoreReportsUnmuted"/>) — the
/// same shape as <c>ActionExecutorTests.QuickDisableAndMutedSkipsTheWholeRunAndEmitsNothing</c>, but
/// with the REAL gate/adapter in front of a substituted store instead of a raw substituted
/// <see cref="IMediaMuteGate"/>, so this specifically exercises the Task 3→Task 4 wiring rather than
/// re-testing the executor's own skip logic.
/// </summary>
public sealed class MediaMuteGateTests
{
  [Fact]
  public async Task GateDelegatesDirectlyToTheStore()
  {
    var store = Substitute.For<IMediaMuteStore>();
    _ = store.GetMutedAsync(Arg.Any<CancellationToken>()).Returns(true);
    var gate = new MediaMuteGate(store);

    var muted = await gate.IsMutedAsync(CancellationToken.None);

    Assert.True(muted);
    _ = await store.Received(1).GetMutedAsync(Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task GateReflectsStoreStateChangesAcrossCalls()
  {
    var store = Substitute.For<IMediaMuteStore>();
    _ = store.GetMutedAsync(Arg.Any<CancellationToken>()).Returns(false, true, false);
    var gate = new MediaMuteGate(store);

    Assert.False(await gate.IsMutedAsync(CancellationToken.None));
    Assert.True(await gate.IsMutedAsync(CancellationToken.None));
    Assert.False(await gate.IsMutedAsync(CancellationToken.None));
  }

  /// <summary>Builds a real <see cref="ActionExecutor"/> whose <see cref="IMediaMuteGate"/> is the
  /// real <see cref="MediaMuteGate"/> wrapping a controllable <see cref="IMediaMuteStore"/> substitute
  /// — every other port is a bare substitute, since this test is only about the mute wiring.</summary>
  private static (ActionExecutor Executor, IActionStore ActionStore, IMediaMuteStore MuteStore) BuildExecutorWithWiredGate()
  {
    var actionStore = Substitute.For<IActionStore>();
    var muteStore = Substitute.For<IMediaMuteStore>();
    var gate = new MediaMuteGate(muteStore);

    var executor = new ActionExecutor(
      actionStore,
      Substitute.For<IMediaResolver>(),
      Substitute.For<IHelixClient>(),
      Substitute.For<IMediator>(),
      Substitute.For<ITtsPort>(),
      Substitute.For<ILlmPort>(),
      Substitute.For<IObsPort>(),
      gate,
      Substitute.For<IActionDelay>(),
      Substitute.For<IRandomIndexSource>(),
      TimeProvider.System,
      NullLogger<ActionExecutor>.Instance);

    return (executor, actionStore, muteStore);
  }

  /// <summary>
  /// One non-blank <c>show_text</c> step: an unmuted run must actually dispatch it (rolling up to
  /// Succeeded), whereas a muted run's quickDisable early-return skips the WHOLE run with an EMPTY
  /// steps list — the two outcomes below are only distinguishable because this action has a step.
  /// </summary>
  private static AutomationAction BuildQuickDisableAction(Guid id) => new(
    Id: id,
    Name: "Quick Disable Action",
    Description: string.Empty,
    Enabled: true,
    QuickDisable: true,
    Steps: [new ShowTextActionStep
    {
      Id = Guid.NewGuid(),
      Enabled = true,
      DelayMs = 0,
      Template = "Hello",
      DurationMs = 5000,
      Style = TextStyle.Banner,
    }],
    CreatedAt: DateTimeOffset.UtcNow,
    UpdatedAt: DateTimeOffset.UtcNow);

  [Fact]
  public async Task QuickDisableActionIsSkippedWhenTheWiredGatesUnderlyingStoreReportsMuted()
  {
    var (executor, actionStore, muteStore) = BuildExecutorWithWiredGate();
    var action = BuildQuickDisableAction(Guid.NewGuid());
    _ = actionStore.GetByIdAsync(action.Id, Arg.Any<CancellationToken>()).Returns(action);
    _ = muteStore.GetMutedAsync(Arg.Any<CancellationToken>()).Returns(true);

    var result = await executor.RunActionAsync(action.Id, new TemplateContext(), CancellationToken.None);

    Assert.Equal(ActionRunStatus.Skipped, result.Status);
    Assert.Empty(result.Steps);
  }

  [Fact]
  public async Task QuickDisableActionRunsNormallyWhenTheWiredGatesUnderlyingStoreReportsUnmuted()
  {
    var (executor, actionStore, muteStore) = BuildExecutorWithWiredGate();
    var action = BuildQuickDisableAction(Guid.NewGuid());
    _ = actionStore.GetByIdAsync(action.Id, Arg.Any<CancellationToken>()).Returns(action);
    _ = muteStore.GetMutedAsync(Arg.Any<CancellationToken>()).Returns(false);

    var result = await executor.RunActionAsync(action.Id, new TemplateContext(), CancellationToken.None);

    // Reached RunStepAsync's Task.WhenAll and actually dispatched the show_text step (rolling up
    // to Succeeded, with the one step present) rather than taking the quickDisable early return,
    // unlike the muted case above.
    Assert.Equal(ActionRunStatus.Succeeded, result.Status);
    _ = Assert.Single(result.Steps);
    _ = await muteStore.Received(1).GetMutedAsync(Arg.Any<CancellationToken>());
  }
}
