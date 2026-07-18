using FluentResults;

using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using Narya.Application.Actions;
using Narya.Application.Automation;
using Narya.Core.Actions;
using Narya.Core.Automation;
using Narya.Core.Chat;
using Narya.Twitch;
using Narya.Twitch.Helix;

namespace Narya.Application.Tests.Automation;

/// <summary>
/// <see cref="TriggerDispatcher"/> tests — a port of legacy's <c>triggerDispatcher.test.ts</c>
/// coverage. <see cref="IActionExecutor"/>/<see cref="IAutomationTriggerStore"/>/
/// <see cref="IHelixClient"/>/<see cref="IActiveModuleProvider"/> are NSubstitute doubles;
/// <see cref="IAutomationRunStore"/> is <see cref="FakeAutomationRunStore"/>, a small in-memory
/// fake that actually enforces the dedupe-key uniqueness the real Postgres partial unique index
/// enforces (proven directly against real Postgres in
/// <c>Narya.Database.Tests.Automation.AutomationRunStoreTests</c>) — using a real fake here (rather
/// than canned NSubstitute returns) lets "invoke twice with the same event id runs the Action
/// once" exercise the actual claim/cooldown interplay, not a scripted mock.
/// </summary>
public sealed class TriggerDispatcherTests
{
  private sealed class FixedTimeProvider : TimeProvider
  {
    public DateTimeOffset Now { get; set; } = DateTimeOffset.UtcNow;

    public override DateTimeOffset GetUtcNow() => Now;
  }

  /// <summary>
  /// A real (if minimal) in-memory implementation, not a mock — see this file's doc comment.
  /// <see cref="Claims"/>/<see cref="Finished"/> let tests assert on exactly what the dispatcher
  /// claimed/finished without re-deriving it from side effects.
  /// </summary>
  private sealed class FakeAutomationRunStore : IAutomationRunStore
  {
    private readonly HashSet<string> _claimedDedupeKeys = [];
    private readonly Dictionary<Guid, DateTimeOffset> _lastRunByTrigger = [];
    private readonly Dictionary<(Guid TriggerId, string ActorLogin), DateTimeOffset> _lastRunByTriggerAndUser = [];

    public List<(Guid RunId, Guid TriggerId, string? DedupeKey, string? ActorLogin, DateTimeOffset RanAt)> Claims { get; } = [];

    public Dictionary<Guid, (ActionRunStatus Status, string Detail)> Finished { get; } = [];

    public Task<bool> TryClaimAsync(
      Guid runId, Guid triggerId, string? dedupeKey, string? actorLogin, DateTimeOffset ranAt, CancellationToken cancellationToken)
    {
      Claims.Add((runId, triggerId, dedupeKey, actorLogin, ranAt));

      if (dedupeKey is not null && !_claimedDedupeKeys.Add(dedupeKey))
      {
        return Task.FromResult(false);
      }

      _lastRunByTrigger[triggerId] = ranAt;
      if (actorLogin is not null)
      {
        _lastRunByTriggerAndUser[(triggerId, actorLogin)] = ranAt;
      }

      return Task.FromResult(true);
    }

    public Task FinishAsync(Guid runId, ActionRunStatus status, string detail, CancellationToken cancellationToken)
    {
      Finished[runId] = (status, detail);
      return Task.CompletedTask;
    }

    public Task<DateTimeOffset?> GetLastRunAtAsync(Guid triggerId, CancellationToken cancellationToken) =>
      Task.FromResult(_lastRunByTrigger.TryGetValue(triggerId, out var value) ? value : (DateTimeOffset?)null);

    public Task<DateTimeOffset?> GetLastUserRunAtAsync(Guid triggerId, string actorLogin, CancellationToken cancellationToken) =>
      Task.FromResult(_lastRunByTriggerAndUser.TryGetValue((triggerId, actorLogin), out var value) ? value : (DateTimeOffset?)null);

    public Task<int> PruneAsync(DateTimeOffset cutoff, CancellationToken cancellationToken) => Task.FromResult(0);
  }

  private sealed record Fixture(
    IAutomationTriggerStore TriggerStore,
    FakeAutomationRunStore RunStore,
    IActionExecutor Executor,
    IHelixClient HelixClient,
    IActiveModuleProvider ActiveModuleProvider,
    FixedTimeProvider TimeProvider,
    ITriggerDispatcher Dispatcher);

  private static Fixture Build()
  {
    var triggerStore = Substitute.For<IAutomationTriggerStore>();
    var runStore = new FakeAutomationRunStore();
    var executor = Substitute.For<IActionExecutor>();
    var helixClient = Substitute.For<IHelixClient>();
    var activeModuleProvider = Substitute.For<IActiveModuleProvider>();
    var timeProvider = new FixedTimeProvider();

    _ = helixClient.GetAuthenticatedUserAsync(TwitchProvider.Bot, Arg.Any<CancellationToken>())
      .Returns(Result.Fail<HelixUser>("bot not configured"));
    _ = activeModuleProvider.GetActiveModuleId().Returns((Guid?)null);
    _ = triggerStore.GetEnabledByKindAsync(Arg.Any<AutomationTriggerKind>(), Arg.Any<CancellationToken>())
      .Returns([]);
    _ = executor.RunActionAsync(Arg.Any<Guid>(), Arg.Any<TemplateContext>(), Arg.Any<CancellationToken>())
      .Returns(callInfo => Task.FromResult(new ActionRunResult(callInfo.Arg<Guid>(), ActionRunStatus.Succeeded, [], timeProvider.GetUtcNow())));

    var dispatcher = new TriggerDispatcher(
      triggerStore, runStore, executor, helixClient, activeModuleProvider, timeProvider, NullLogger<TriggerDispatcher>.Instance);

    return new Fixture(triggerStore, runStore, executor, helixClient, activeModuleProvider, timeProvider, dispatcher);
  }

  private static AutomationTrigger BuildTrigger(
    AutomationTriggerKind kind = AutomationTriggerKind.Manual,
    Guid? id = null,
    Guid? actionId = null,
    Guid? moduleId = null,
    bool enabled = true,
    int globalCooldownMs = 0,
    int userCooldownMs = 0,
    TriggerConfig? config = null) => new(
      Id: id ?? Guid.NewGuid(),
      Kind: kind,
      ActionId: actionId ?? Guid.NewGuid(),
      ModuleId: moduleId,
      Enabled: enabled,
      GlobalCooldownMs: globalCooldownMs,
      UserCooldownMs: userCooldownMs,
      Config: config ?? new ManualTriggerConfig { Label = "Test" },
      CreatedAt: DateTimeOffset.UtcNow,
      UpdatedAt: DateTimeOffset.UtcNow);

  // ---------------------------------------------------------------------------------------
  // Dedup
  // ---------------------------------------------------------------------------------------

  [Fact]
  public async Task InvokeAsyncTwiceWithTheSameEventIdRunsTheActionOnlyOnce()
  {
    var f = Build();
    var trigger = BuildTrigger();
    var options = new TriggerInvokeOptions { EventId = "evt-1" };

    var first = await f.Dispatcher.InvokeAsync(trigger, new TemplateContext(), options, CancellationToken.None);
    var second = await f.Dispatcher.InvokeAsync(trigger, new TemplateContext(), options, CancellationToken.None);

    Assert.NotNull(first);
    Assert.Null(second);
    _ = await f.Executor.Received(1).RunActionAsync(trigger.ActionId, Arg.Any<TemplateContext>(), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task TwoManualRunsWithNoEventIdBothInvokeTheExecutor()
  {
    var f = Build();
    var trigger = BuildTrigger();
    _ = f.TriggerStore.GetByIdAsync(trigger.Id, Arg.Any<CancellationToken>()).Returns(trigger);

    _ = await f.Dispatcher.RunTriggerManuallyAsync(trigger.Id, new TemplateContext(), CancellationToken.None);
    _ = await f.Dispatcher.RunTriggerManuallyAsync(trigger.Id, new TemplateContext(), CancellationToken.None);

    _ = await f.Executor.Received(2).RunActionAsync(trigger.ActionId, Arg.Any<TemplateContext>(), Arg.Any<CancellationToken>());
  }

  // ---------------------------------------------------------------------------------------
  // finishRun
  // ---------------------------------------------------------------------------------------

  [Fact]
  public async Task ASuccessfulRunUpdatesTheProvisionalRowFromFailedToTheRealStatus()
  {
    var f = Build();
    var trigger = BuildTrigger();

    var summary = await f.Dispatcher.InvokeAsync(trigger, new TemplateContext(), null, CancellationToken.None);

    Assert.NotNull(summary);
    var runId = f.RunStore.Claims[0].RunId;
    Assert.Equal(ActionRunStatus.Succeeded, f.RunStore.Finished[runId].Status);
  }

  [Fact]
  public async Task AnExecutorExceptionFinishesTheRunAsFailedAndReturnsAFailedSummary()
  {
    var f = Build();
    var trigger = BuildTrigger();
    _ = f.Executor.RunActionAsync(trigger.ActionId, Arg.Any<TemplateContext>(), Arg.Any<CancellationToken>())
      .Returns<Task<ActionRunResult>>(_ => throw new InvalidOperationException("boom"));

    var summary = await f.Dispatcher.InvokeAsync(trigger, new TemplateContext(), null, CancellationToken.None);

    Assert.NotNull(summary);
    Assert.Equal(ActionRunStatus.Failed, summary!.Result.Status);
    var runId = f.RunStore.Claims[0].RunId;
    Assert.Equal(ActionRunStatus.Failed, f.RunStore.Finished[runId].Status);
    Assert.Equal("boom", f.RunStore.Finished[runId].Detail);
  }

  // ---------------------------------------------------------------------------------------
  // Cooldowns
  // ---------------------------------------------------------------------------------------

  [Fact]
  public async Task AGlobalCooldownBlocksASecondInvokeWithinTheWindow()
  {
    var f = Build();
    var trigger = BuildTrigger(globalCooldownMs: 30_000);

    var first = await f.Dispatcher.InvokeAsync(trigger, new TemplateContext(), null, CancellationToken.None);
    f.TimeProvider.Now = f.TimeProvider.Now.AddSeconds(10);
    var second = await f.Dispatcher.InvokeAsync(trigger, new TemplateContext(), null, CancellationToken.None);

    Assert.NotNull(first);
    Assert.Null(second);
  }

  [Fact]
  public async Task AGlobalCooldownAllowsAnInvokeOnceTheWindowHasPassed()
  {
    var f = Build();
    var trigger = BuildTrigger(globalCooldownMs: 30_000);

    var first = await f.Dispatcher.InvokeAsync(trigger, new TemplateContext(), null, CancellationToken.None);
    f.TimeProvider.Now = f.TimeProvider.Now.AddSeconds(31);
    var second = await f.Dispatcher.InvokeAsync(trigger, new TemplateContext(), null, CancellationToken.None);

    Assert.NotNull(first);
    Assert.NotNull(second);
  }

  [Fact]
  public async Task AUserCooldownBlocksTheSameActorWithinTheWindow()
  {
    var f = Build();
    var trigger = BuildTrigger(userCooldownMs: 30_000);
    var options = new TriggerInvokeOptions { ActorLogin = "alice" };

    var first = await f.Dispatcher.InvokeAsync(trigger, new TemplateContext(), options, CancellationToken.None);
    f.TimeProvider.Now = f.TimeProvider.Now.AddSeconds(10);
    var second = await f.Dispatcher.InvokeAsync(trigger, new TemplateContext(), options, CancellationToken.None);

    Assert.NotNull(first);
    Assert.Null(second);
  }

  [Fact]
  public async Task AUserCooldownDoesNotBlockADifferentActor()
  {
    var f = Build();
    var trigger = BuildTrigger(userCooldownMs: 30_000);

    var first = await f.Dispatcher.InvokeAsync(trigger, new TemplateContext(), new TriggerInvokeOptions { ActorLogin = "alice" }, CancellationToken.None);
    var second = await f.Dispatcher.InvokeAsync(trigger, new TemplateContext(), new TriggerInvokeOptions { ActorLogin = "bob" }, CancellationToken.None);

    Assert.NotNull(first);
    Assert.NotNull(second);
  }

  [Fact]
  public async Task ACooldownOfZeroDisablesTheCheck()
  {
    var f = Build();
    var trigger = BuildTrigger(globalCooldownMs: 0, userCooldownMs: 0);

    var first = await f.Dispatcher.InvokeAsync(trigger, new TemplateContext(), null, CancellationToken.None);
    var second = await f.Dispatcher.InvokeAsync(trigger, new TemplateContext(), null, CancellationToken.None);

    Assert.NotNull(first);
    Assert.NotNull(second);
  }

  // ---------------------------------------------------------------------------------------
  // isArmed
  // ---------------------------------------------------------------------------------------

  [Fact]
  public async Task AModuleScopedTriggerIsNotArmedWhileNoModuleIsActive()
  {
    var f = Build();
    var trigger = BuildTrigger(moduleId: Guid.NewGuid());

    var summary = await f.Dispatcher.InvokeAsync(trigger, new TemplateContext(), null, CancellationToken.None);

    Assert.Null(summary);
    _ = await f.Executor.DidNotReceive().RunActionAsync(Arg.Any<Guid>(), Arg.Any<TemplateContext>(), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task AModuleScopedTriggerIsArmedWhileItsModuleIsActive()
  {
    var f = Build();
    var moduleId = Guid.NewGuid();
    _ = f.ActiveModuleProvider.GetActiveModuleId().Returns(moduleId);
    var trigger = BuildTrigger(moduleId: moduleId);

    var summary = await f.Dispatcher.InvokeAsync(trigger, new TemplateContext(), null, CancellationToken.None);

    Assert.NotNull(summary);
  }

  [Fact]
  public async Task AGlobalTriggerIsAlwaysArmed()
  {
    var f = Build();
    var trigger = BuildTrigger(moduleId: null);

    var summary = await f.Dispatcher.InvokeAsync(trigger, new TemplateContext(), null, CancellationToken.None);

    Assert.NotNull(summary);
  }

  [Fact]
  public async Task ManualRunsBypassArmingAndCooldownButStillDedupClaim()
  {
    var f = Build();
    var trigger = BuildTrigger(moduleId: Guid.NewGuid(), globalCooldownMs: 999_999_999);
    _ = f.TriggerStore.GetByIdAsync(trigger.Id, Arg.Any<CancellationToken>()).Returns(trigger);

    var result = await f.Dispatcher.RunTriggerManuallyAsync(trigger.Id, new TemplateContext(), CancellationToken.None);

    Assert.NotNull(result);
    Assert.Equal(ActionRunStatus.Succeeded, result!.Status);
  }

  [Fact]
  public async Task RunTriggerManuallyReturnsNullForAnUnknownTriggerId()
  {
    var f = Build();
    _ = f.TriggerStore.GetByIdAsync(Arg.Any<Guid>(), Arg.Any<CancellationToken>()).Returns((AutomationTrigger?)null);

    var result = await f.Dispatcher.RunTriggerManuallyAsync(Guid.NewGuid(), new TemplateContext(), CancellationToken.None);

    Assert.Null(result);
  }

  // ---------------------------------------------------------------------------------------
  // Bot-loop guard
  // ---------------------------------------------------------------------------------------

  [Fact]
  public async Task HandleChatMessageReturnsEmptyForTheBotsOwnMessageAndNeverMatches()
  {
    var f = Build();
    _ = f.HelixClient.GetAuthenticatedUserAsync(TwitchProvider.Bot, Arg.Any<CancellationToken>())
      .Returns(Result.Ok(new HelixUser { Id = "bot-id", Login = "naryabot" }));
    var message = new ChatMessage("msg-1", "codeacula", "NaryaBot", "NaryaBot", null, "!quack", DateTimeOffset.UtcNow, null, "bot-id");

    var summaries = await f.Dispatcher.HandleChatMessageAsync(message, CancellationToken.None);

    Assert.Empty(summaries);
    _ = await f.TriggerStore.DidNotReceive().GetEnabledByKindAsync(Arg.Any<AutomationTriggerKind>(), Arg.Any<CancellationToken>());
  }

  // ---------------------------------------------------------------------------------------
  // Matching — chat_phrase
  // ---------------------------------------------------------------------------------------

  [Fact]
  public async Task ChatPhraseExactMatchesOnlyTheWholeTrimmedMessage()
  {
    var f = Build();
    var trigger = BuildTrigger(kind: AutomationTriggerKind.ChatPhrase, config: new ChatPhraseTriggerConfig { Phrase = "hype", Match = ChatPhraseMatch.Exact });
    _ = f.TriggerStore.GetEnabledByKindAsync(AutomationTriggerKind.ChatPhrase, Arg.Any<CancellationToken>()).Returns([trigger]);

    var hit = await f.Dispatcher.HandleChatMessageAsync(BuildMessage("hype"), CancellationToken.None);
    var miss = await f.Dispatcher.HandleChatMessageAsync(BuildMessage("so much hype today"), CancellationToken.None);

    _ = Assert.Single(hit);
    Assert.Empty(miss);
  }

  [Fact]
  public async Task ChatPhraseContainsMatchesAnywhereInTheMessage()
  {
    var f = Build();
    var trigger = BuildTrigger(kind: AutomationTriggerKind.ChatPhrase, config: new ChatPhraseTriggerConfig { Phrase = "hype", Match = ChatPhraseMatch.Contains });
    _ = f.TriggerStore.GetEnabledByKindAsync(AutomationTriggerKind.ChatPhrase, Arg.Any<CancellationToken>()).Returns([trigger]);

    var hit = await f.Dispatcher.HandleChatMessageAsync(BuildMessage("so much HYPE today"), CancellationToken.None);

    _ = Assert.Single(hit);
  }

  [Fact]
  public async Task ChatPhraseStartsWithMatchesOnlyTheStartAndCapturesTheRemainder()
  {
    var f = Build();
    var trigger = BuildTrigger(kind: AutomationTriggerKind.ChatPhrase, config: new ChatPhraseTriggerConfig { Phrase = "!hype", Match = ChatPhraseMatch.StartsWith });
    _ = f.TriggerStore.GetEnabledByKindAsync(AutomationTriggerKind.ChatPhrase, Arg.Any<CancellationToken>()).Returns([trigger]);

    var hit = await f.Dispatcher.HandleChatMessageAsync(BuildMessage("!hype train incoming"), CancellationToken.None);
    var miss = await f.Dispatcher.HandleChatMessageAsync(BuildMessage("so !hype"), CancellationToken.None);

    _ = Assert.Single(hit);
    Assert.Empty(miss);
  }

  [Fact]
  public async Task ARoleRestrictedChatPhraseTriggerIsSkippedForAViewerWithoutTheRole()
  {
    var f = Build();
    var trigger = BuildTrigger(
      kind: AutomationTriggerKind.ChatPhrase,
      config: new ChatPhraseTriggerConfig { Phrase = "hype", Match = ChatPhraseMatch.Contains, Roles = [TriggerRole.Mod] });
    _ = f.TriggerStore.GetEnabledByKindAsync(AutomationTriggerKind.ChatPhrase, Arg.Any<CancellationToken>()).Returns([trigger]);

    var fromViewer = await f.Dispatcher.HandleChatMessageAsync(BuildMessage("hype", badges: null), CancellationToken.None);
    var fromMod = await f.Dispatcher.HandleChatMessageAsync(
      BuildMessage("hype", badges: new Dictionary<string, string> { ["moderator"] = "1" }), CancellationToken.None);

    Assert.Empty(fromViewer);
    _ = Assert.Single(fromMod);
  }

  [Fact]
  public async Task MultiplePhraseTriggersMatchingTheSameMessageAllFire()
  {
    var f = Build();
    var soundTrigger = BuildTrigger(kind: AutomationTriggerKind.ChatPhrase, config: new ChatPhraseTriggerConfig { Phrase = "hype", Match = ChatPhraseMatch.Contains });
    var bannerTrigger = BuildTrigger(kind: AutomationTriggerKind.ChatPhrase, config: new ChatPhraseTriggerConfig { Phrase = "hype train", Match = ChatPhraseMatch.Contains });
    _ = f.TriggerStore.GetEnabledByKindAsync(AutomationTriggerKind.ChatPhrase, Arg.Any<CancellationToken>()).Returns([soundTrigger, bannerTrigger]);

    var summaries = await f.Dispatcher.HandleChatMessageAsync(BuildMessage("hype train incoming"), CancellationToken.None);

    Assert.Equal(2, summaries.Count);
  }

  // ---------------------------------------------------------------------------------------
  // Matching — viewer_command
  // ---------------------------------------------------------------------------------------

  [Fact]
  public async Task ViewerCommandMatchesTheWordOrAnAlias()
  {
    var f = Build();
    var trigger = BuildTrigger(
      kind: AutomationTriggerKind.ViewerCommand,
      config: new ViewerCommandTriggerConfig { Command = "!quack", Aliases = ["!honk"] });
    _ = f.TriggerStore.GetEnabledByKindAsync(AutomationTriggerKind.ViewerCommand, Arg.Any<CancellationToken>()).Returns([trigger]);

    var byCommand = await f.Dispatcher.HandleChatMessageAsync(BuildMessage("!quack"), CancellationToken.None);
    var byAlias = await f.Dispatcher.HandleChatMessageAsync(BuildMessage("!honk"), CancellationToken.None);
    var miss = await f.Dispatcher.HandleChatMessageAsync(BuildMessage("!other"), CancellationToken.None);

    _ = Assert.Single(byCommand);
    _ = Assert.Single(byAlias);
    Assert.Empty(miss);
  }

  // ---------------------------------------------------------------------------------------
  // Matching — twitch_event / reward
  // ---------------------------------------------------------------------------------------

  [Fact]
  public async Task TwitchEventMatchesOnlyTheConfiguredKind()
  {
    var f = Build();
    var trigger = BuildTrigger(kind: AutomationTriggerKind.TwitchEvent, config: new TwitchEventTriggerConfig { EventKind = TwitchAlertEventKind.Raid });
    _ = f.TriggerStore.GetEnabledByKindAsync(AutomationTriggerKind.TwitchEvent, Arg.Any<CancellationToken>()).Returns([trigger]);

    var raid = new TwitchEventSignalNotification(TwitchAlertEventKind.Raid, "evt-1", "Raider", "raider", 12, null, null);
    var cheer = new TwitchEventSignalNotification(TwitchAlertEventKind.Cheer, "evt-2", "Cheerer", "cheerer", 100, null, null);

    var hit = await f.Dispatcher.HandleTwitchEventAsync(raid, CancellationToken.None);
    var miss = await f.Dispatcher.HandleTwitchEventAsync(cheer, CancellationToken.None);

    _ = Assert.Single(hit);
    Assert.Empty(miss);
  }

  [Fact]
  public async Task RewardRedemptionMatchesOnlyTheConfiguredRewardId()
  {
    var f = Build();
    var trigger = BuildTrigger(kind: AutomationTriggerKind.Reward, config: new RewardTriggerConfig { RewardId = "reward-abc" });
    _ = f.TriggerStore.GetEnabledByKindAsync(AutomationTriggerKind.Reward, Arg.Any<CancellationToken>()).Returns([trigger]);

    var matching = new RewardRedeemedSignalNotification("evt-1", "reward-abc", "Play a sound", "Redeemer", "redeemer", null);
    var other = new RewardRedeemedSignalNotification("evt-2", "reward-xyz", "Something else", "Redeemer", "redeemer", null);

    var hit = await f.Dispatcher.HandleRewardRedemptionAsync(matching, CancellationToken.None);
    var miss = await f.Dispatcher.HandleRewardRedemptionAsync(other, CancellationToken.None);

    _ = Assert.Single(hit);
    Assert.Empty(miss);
  }

  // ---------------------------------------------------------------------------------------
  // Slash commands
  // ---------------------------------------------------------------------------------------

  [Fact]
  public async Task AnUnknownSlashCommandReturnsOkFalseAndNeverInvokesTheExecutor()
  {
    var f = Build();

    var response = await f.Dispatcher.HandleSlashCommandAsync("/nosuchcommand target", CancellationToken.None);

    Assert.False(response.Ok);
    Assert.Contains("Unknown command", response.Message, StringComparison.Ordinal);
    Assert.Null(response.Run);
    _ = await f.Executor.DidNotReceive().RunActionAsync(Arg.Any<Guid>(), Arg.Any<TemplateContext>(), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task ACoolingDownSlashCommandReturnsOkFalseWithACoolingDownMessage()
  {
    var f = Build();
    var trigger = BuildTrigger(
      kind: AutomationTriggerKind.DashboardSlash, globalCooldownMs: 30_000,
      config: new DashboardSlashTriggerConfig { Command = "/shoutout", Aliases = [] });
    _ = f.TriggerStore.GetEnabledByKindAsync(AutomationTriggerKind.DashboardSlash, Arg.Any<CancellationToken>()).Returns([trigger]);

    _ = await f.Dispatcher.HandleSlashCommandAsync("/shoutout someviewer", CancellationToken.None);
    var response = await f.Dispatcher.HandleSlashCommandAsync("/shoutout someviewer", CancellationToken.None);

    Assert.False(response.Ok);
    Assert.Contains("cooling down", response.Message, StringComparison.Ordinal);
  }

  [Fact]
  public async Task ASuccessfulSlashCommandReturnsOkTrueAndBindsTheTargetAsActorAndLogin()
  {
    var f = Build();
    var trigger = BuildTrigger(kind: AutomationTriggerKind.DashboardSlash, config: new DashboardSlashTriggerConfig { Command = "/shoutout", Aliases = [] });
    _ = f.TriggerStore.GetEnabledByKindAsync(AutomationTriggerKind.DashboardSlash, Arg.Any<CancellationToken>()).Returns([trigger]);
    TemplateContext? captured = null;
    _ = f.Executor.RunActionAsync(trigger.ActionId, Arg.Any<TemplateContext>(), Arg.Any<CancellationToken>())
      .Returns(callInfo =>
      {
        captured = callInfo.Arg<TemplateContext>();
        return Task.FromResult(new ActionRunResult(trigger.ActionId, ActionRunStatus.Succeeded, [], DateTimeOffset.UtcNow));
      });

    var response = await f.Dispatcher.HandleSlashCommandAsync("/shoutout @SomeViewer", CancellationToken.None);

    Assert.True(response.Ok);
    Assert.NotNull(response.Run);
    Assert.NotNull(captured);
    Assert.Equal("SomeViewer", captured!.Actor);
    Assert.Equal("someviewer", captured.Login);
  }

  [Fact]
  public async Task ASlashCommandInputMissingTheLeadingSlashReturnsOkFalse()
  {
    var f = Build();

    var response = await f.Dispatcher.HandleSlashCommandAsync("shoutout someviewer", CancellationToken.None);

    Assert.False(response.Ok);
    Assert.Contains("must start with /", response.Message, StringComparison.Ordinal);
  }

  private static ChatMessage BuildMessage(string text, IReadOnlyDictionary<string, string>? badges = null) =>
    new(Guid.NewGuid().ToString(), "codeacula", "someviewer", "SomeViewer", null, text, DateTimeOffset.UtcNow, badges, "viewer-id");
}
