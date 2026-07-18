using FluentResults;

using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using Narya.Application.Actions;
using Narya.Application.Automation;
using Narya.Application.Chat;
using Narya.Core.Actions;
using Narya.Core.Automation;
using Narya.Core.Chat;
using Narya.Twitch;
using Narya.Twitch.Helix;

namespace Narya.Application.Tests.Automation;

/// <summary>
/// <see cref="ChatMessageTriggerHandler"/>/<see cref="TwitchEventTriggerHandler"/>/
/// <see cref="RewardRedeemedTriggerHandler"/> — the thin <c>INotificationHandler&lt;T&gt;</c>
/// shells MediatR's assembly scan discovers and Phase 2's EventSub dispatch layer (via
/// <c>TwitchEventSubService</c>) and Phase 3's post-persist chat broadcast (via
/// <c>PersistChatMessageHandler</c>) publish into. Each "delegates" test uses a mocked
/// <see cref="ITriggerDispatcher"/>; the "redelivery" test wires a REAL
/// <see cref="TriggerDispatcher"/> (with the same fake run-store/mocked-executor shape as
/// <c>TriggerDispatcherTests</c>) so publishing the identical signal twice proves the dedup
/// guarantee survives the handler indirection, not just a direct <c>InvokeAsync</c> call — the
/// light version of Task 7's fuller redeem-once guard.
/// </summary>
public sealed class AutomationSignalHandlersTests
{
  [Fact]
  public async Task ChatMessageTriggerHandlerDelegatesToHandleChatMessageAsync()
  {
    var dispatcher = Substitute.For<ITriggerDispatcher>();
    var handler = new ChatMessageTriggerHandler(dispatcher);
    var message = new ChatMessage("msg-1", "codeacula", "someviewer", "SomeViewer", null, "hype", DateTimeOffset.UtcNow, null, "viewer-id");

    await handler.Handle(new ChatMessageBroadcastNotification(message), CancellationToken.None);

    _ = await dispatcher.Received(1).HandleChatMessageAsync(message, Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task TwitchEventTriggerHandlerDelegatesToHandleTwitchEventAsync()
  {
    var dispatcher = Substitute.For<ITriggerDispatcher>();
    var handler = new TwitchEventTriggerHandler(dispatcher);
    var signal = new TwitchEventSignalNotification(TwitchAlertEventKind.Follow, "evt-1", "Follower", "follower", null, null, null);

    await handler.Handle(signal, CancellationToken.None);

    _ = await dispatcher.Received(1).HandleTwitchEventAsync(signal, Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task RewardRedeemedTriggerHandlerDelegatesToHandleRewardRedemptionAsync()
  {
    var dispatcher = Substitute.For<ITriggerDispatcher>();
    var handler = new RewardRedeemedTriggerHandler(dispatcher);
    var signal = new RewardRedeemedSignalNotification("evt-1", "reward-abc", "Play a sound", "Redeemer", "redeemer", null);

    await handler.Handle(signal, CancellationToken.None);

    _ = await dispatcher.Received(1).HandleRewardRedemptionAsync(signal, Arg.Any<CancellationToken>());
  }

  /// <summary>
  /// Publishing the SAME <see cref="TwitchEventSignalNotification"/> (identical <c>EventId</c>,
  /// as a redelivery would carry) through <see cref="TwitchEventTriggerHandler"/> twice must fire
  /// the matched trigger's Action only once — proves the dedup guarantee holds through the
  /// MediatR handler entry point, not just a direct dispatcher call.
  /// </summary>
  [Fact]
  public async Task RedeliveringTheSameTwitchEventSignalThroughTheHandlerFiresTheActionOnce()
  {
    var triggerStore = Substitute.For<IAutomationTriggerStore>();
    var runStore = new InMemoryRunStore();
    var executor = Substitute.For<IActionExecutor>();
    var helixClient = Substitute.For<IHelixClient>();
    var activeModuleProvider = Substitute.For<IActiveModuleProvider>();
    var timeProvider = TimeProvider.System;

    _ = helixClient.GetAuthenticatedUserAsync(TwitchProvider.Bot, Arg.Any<CancellationToken>())
      .Returns(Result.Fail<HelixUser>("bot not configured"));
    _ = activeModuleProvider.GetActiveModuleId().Returns((Guid?)null);

    var actionId = Guid.NewGuid();
    var trigger = new AutomationTrigger(
      Id: Guid.NewGuid(), Kind: AutomationTriggerKind.TwitchEvent, ActionId: actionId, ModuleId: null, Enabled: true,
      GlobalCooldownMs: 0, UserCooldownMs: 0, Config: new TwitchEventTriggerConfig { EventKind = TwitchAlertEventKind.Follow },
      CreatedAt: DateTimeOffset.UtcNow, UpdatedAt: DateTimeOffset.UtcNow);
    _ = triggerStore.GetEnabledByKindAsync(AutomationTriggerKind.TwitchEvent, Arg.Any<CancellationToken>()).Returns([trigger]);
    _ = executor.RunActionAsync(actionId, Arg.Any<TemplateContext>(), Arg.Any<CancellationToken>())
      .Returns(Task.FromResult(new ActionRunResult(actionId, ActionRunStatus.Succeeded, [], DateTimeOffset.UtcNow)));

    var dispatcher = new TriggerDispatcher(
      triggerStore, runStore, executor, helixClient, activeModuleProvider, timeProvider, NullLogger<TriggerDispatcher>.Instance);
    var handler = new TwitchEventTriggerHandler(dispatcher);
    var signal = new TwitchEventSignalNotification(TwitchAlertEventKind.Follow, "redelivered-msg-id", "Follower", "follower", null, null, null);

    await handler.Handle(signal, CancellationToken.None);
    await handler.Handle(signal, CancellationToken.None);

    _ = await executor.Received(1).RunActionAsync(actionId, Arg.Any<TemplateContext>(), Arg.Any<CancellationToken>());
  }

  /// <summary>Minimal claim-tracking fake — see <c>TriggerDispatcherTests.FakeAutomationRunStore</c> for the fuller version this mirrors.</summary>
  private sealed class InMemoryRunStore : IAutomationRunStore
  {
    private readonly HashSet<string> _claimedDedupeKeys = [];

    public Task<bool> TryClaimAsync(
      Guid runId, Guid triggerId, string? dedupeKey, string? actorLogin, DateTimeOffset ranAt, CancellationToken cancellationToken) =>
      Task.FromResult(dedupeKey is null || _claimedDedupeKeys.Add(dedupeKey));

    public Task FinishAsync(Guid runId, ActionRunStatus status, string detail, CancellationToken cancellationToken) => Task.CompletedTask;

    public Task<DateTimeOffset?> GetLastRunAtAsync(Guid triggerId, CancellationToken cancellationToken) =>
      Task.FromResult((DateTimeOffset?)null);

    public Task<DateTimeOffset?> GetLastUserRunAtAsync(Guid triggerId, string actorLogin, CancellationToken cancellationToken) =>
      Task.FromResult((DateTimeOffset?)null);

    public Task<int> PruneAsync(DateTimeOffset cutoff, CancellationToken cancellationToken) => Task.FromResult(0);
  }
}
