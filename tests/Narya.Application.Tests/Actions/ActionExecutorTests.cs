using FluentResults;

using MediatR;

using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using Narya.Application.Actions;
using Narya.Core.Actions;
using Narya.Core.Media;
using Narya.Twitch;
using Narya.Twitch.Helix;

namespace Narya.Application.Tests.Actions;

/// <summary>
/// <see cref="ActionExecutor"/> tests — a port of legacy's <c>actionExecutor.test.ts</c> coverage,
/// all with test doubles (no real Twitch/DB/socket; every port is injected for exactly this — see
/// <see cref="ActionExecutor"/>'s and <c>IActionStepPorts.cs</c>'s doc comments).
/// </summary>
public sealed class ActionExecutorTests
{
  private sealed record Fixture(
    IActionStore ActionStore,
    IMediaResolver MediaResolver,
    IHelixClient HelixClient,
    IMediator Mediator,
    ITtsPort TtsPort,
    ILlmPort LlmPort,
    IObsPort ObsPort,
    IMediaMuteGate MuteGate,
    IActionDelay Delay,
    IRandomIndexSource RandomIndexSource,
    ActionExecutor Executor);

  private static Fixture Build()
  {
    var actionStore = Substitute.For<IActionStore>();
    var mediaResolver = Substitute.For<IMediaResolver>();
    var helixClient = Substitute.For<IHelixClient>();
    var mediator = Substitute.For<IMediator>();
    var ttsPort = Substitute.For<ITtsPort>();
    var llmPort = Substitute.For<ILlmPort>();
    var obsPort = Substitute.For<IObsPort>();
    var muteGate = Substitute.For<IMediaMuteGate>();
    var delay = Substitute.For<IActionDelay>();
    var randomIndexSource = Substitute.For<IRandomIndexSource>();

    _ = delay.DelayAsync(Arg.Any<int>(), Arg.Any<CancellationToken>()).Returns(Task.CompletedTask);
    _ = muteGate.IsMutedAsync(Arg.Any<CancellationToken>()).Returns(false);
    _ = helixClient.ResolveUserIdAsync(Arg.Any<string>(), Arg.Any<CancellationToken>())
      .Returns(callInfo => Result.Ok(callInfo.Arg<string>() + "-id"));
    _ = helixClient.SendChatMessageAsync(Arg.Any<TwitchProvider>(), Arg.Any<string>(), Arg.Any<string?>(), Arg.Any<CancellationToken>())
      .Returns(Result.Ok("message-id"));
    _ = helixClient.SendShoutoutAsync(Arg.Any<string>(), Arg.Any<CancellationToken>()).Returns(Result.Ok());
    _ = helixClient.SendWhisperAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<CancellationToken>()).Returns(Result.Ok());
    _ = helixClient.BanOrTimeoutAsync(Arg.Any<string>(), Arg.Any<int?>(), Arg.Any<string?>(), Arg.Any<CancellationToken>()).Returns(Result.Ok());

    var executor = new ActionExecutor(
      actionStore, mediaResolver, helixClient, mediator, ttsPort, llmPort, obsPort, muteGate, delay, randomIndexSource,
      TimeProvider.System, NullLogger<ActionExecutor>.Instance);

    return new Fixture(actionStore, mediaResolver, helixClient, mediator, ttsPort, llmPort, obsPort, muteGate, delay, randomIndexSource, executor);
  }

  private static async Task<ActionRunResult> RunAsync(Fixture f, AutomationAction action, TemplateContext? context = null)
  {
    _ = f.ActionStore.GetByIdAsync(action.Id, Arg.Any<CancellationToken>()).Returns(action);
    return await f.Executor.RunActionAsync(action.Id, context ?? new TemplateContext(), CancellationToken.None);
  }

  private static AutomationAction BuildAction(bool enabled = true, bool quickDisable = false, IReadOnlyList<ActionStep>? steps = null) => new(
    Id: Guid.NewGuid(),
    Name: "Test Action",
    Description: string.Empty,
    Enabled: enabled,
    QuickDisable: quickDisable,
    Steps: steps ?? [],
    CreatedAt: DateTimeOffset.UtcNow,
    UpdatedAt: DateTimeOffset.UtcNow);

  private static MediaAsset BuildMediaAsset(Guid id, double volume = 0.8, string src = "quack.mp3") => new(
    id, "Label", MediaKind.Audio, MediaSourceType.Local, src, volume, Enabled: true, Available: true,
    CreatedAt: DateTimeOffset.UtcNow, UpdatedAt: DateTimeOffset.UtcNow);

  // ---- step builders ----------------------------------------------------------------------

  private static ShowTextActionStep ShowText(
    string template = "Hello {actor}", int delayMs = 0, bool enabled = true,
    TextStyle style = TextStyle.Banner, int durationMs = 5000, string? tone = null)
  {
    return new ShowTextActionStep
    {
      Id = Guid.NewGuid(),
      Enabled = enabled,
      DelayMs = delayMs,
      Template = template,
      DurationMs = durationMs,
      Style = style,
      Tone = tone,
    };
  }

  private static PlayMediaActionStep PlayMedia(
    IReadOnlyList<Guid> assetIds, MediaSelection selection = MediaSelection.First, double? volume = null,
    int delayMs = 0, bool enabled = true)
  {
    return new PlayMediaActionStep
    {
      Id = Guid.NewGuid(),
      Enabled = enabled,
      DelayMs = delayMs,
      AssetIds = assetIds,
      Selection = selection,
      Volume = volume,
    };
  }

  private static SendChatActionStep SendChat(string template = "hi", ChatSender sender = ChatSender.Bot, int delayMs = 0, bool enabled = true)
  {
    return new SendChatActionStep
    {
      Id = Guid.NewGuid(),
      Enabled = enabled,
      DelayMs = delayMs,
      Template = template,
      Sender = sender,
    };
  }

  private static ObsTransitionActionStep ObsTransition(int delayMs = 0, bool enabled = true) =>
    new() { Id = Guid.NewGuid(), Enabled = enabled, DelayMs = delayMs };

  private static TwitchShoutoutActionStep Shoutout(string loginTemplate = "bob", int delayMs = 0, bool enabled = true)
  {
    return new TwitchShoutoutActionStep
    {
      Id = Guid.NewGuid(),
      Enabled = enabled,
      DelayMs = delayMs,
      LoginTemplate = loginTemplate,
    };
  }

  private static TwitchWhisperActionStep Whisper(string loginTemplate = "bob", string template = "hi", int delayMs = 0, bool enabled = true)
  {
    return new TwitchWhisperActionStep
    {
      Id = Guid.NewGuid(),
      Enabled = enabled,
      DelayMs = delayMs,
      LoginTemplate = loginTemplate,
      Template = template,
    };
  }

  private static TwitchTimeoutActionStep Timeout(
    string loginTemplate = "bob", string secondsTemplate = "300", string reasonTemplate = "spam",
    int delayMs = 0, bool enabled = true)
  {
    return new TwitchTimeoutActionStep
    {
      Id = Guid.NewGuid(),
      Enabled = enabled,
      DelayMs = delayMs,
      LoginTemplate = loginTemplate,
      SecondsTemplate = secondsTemplate,
      ReasonTemplate = reasonTemplate,
    };
  }

  private static TwitchBanActionStep Ban(string loginTemplate = "bob", string reasonTemplate = "spam", int delayMs = 0, bool enabled = true)
  {
    return new TwitchBanActionStep
    {
      Id = Guid.NewGuid(),
      Enabled = enabled,
      DelayMs = delayMs,
      LoginTemplate = loginTemplate,
      ReasonTemplate = reasonTemplate,
    };
  }

  // ---------------------------------------------------------------------------------------
  // Missing / disabled Action / quickDisable+mute
  // ---------------------------------------------------------------------------------------

  [Fact]
  public async Task MissingActionReturnsSkippedWithNoSteps()
  {
    var f = Build();
    var id = Guid.NewGuid();
    _ = f.ActionStore.GetByIdAsync(id, Arg.Any<CancellationToken>()).Returns((AutomationAction?)null);

    var result = await f.Executor.RunActionAsync(id, new TemplateContext(), CancellationToken.None);

    Assert.Equal(ActionRunStatus.Skipped, result.Status);
    Assert.Empty(result.Steps);
  }

  [Fact]
  public async Task DisabledActionReturnsSkippedWithNoSteps()
  {
    var f = Build();
    var action = BuildAction(enabled: false, steps: [ObsTransition()]);

    var result = await RunAsync(f, action);

    Assert.Equal(ActionRunStatus.Skipped, result.Status);
    Assert.Empty(result.Steps);
  }

  [Fact]
  public async Task QuickDisableAndMutedSkipsTheWholeRunAndEmitsNothing()
  {
    var f = Build();
    _ = f.MuteGate.IsMutedAsync(Arg.Any<CancellationToken>()).Returns(true);
    var assetId = Guid.NewGuid();
    var action = BuildAction(quickDisable: true, steps: [ShowText(), PlayMedia([assetId])]);

    var result = await RunAsync(f, action);

    Assert.Equal(ActionRunStatus.Skipped, result.Status);
    Assert.Empty(result.Steps);
    Assert.Empty(f.Mediator.ReceivedCalls());
    Assert.Empty(f.MediaResolver.ReceivedCalls());
    Assert.Empty(f.HelixClient.ReceivedCalls());
    Assert.Empty(f.TtsPort.ReceivedCalls());
    Assert.Empty(f.ObsPort.ReceivedCalls());
  }

  [Fact]
  public async Task QuickDisableButNotMutedRunsNormally()
  {
    var f = Build();
    _ = f.MuteGate.IsMutedAsync(Arg.Any<CancellationToken>()).Returns(false);
    var action = BuildAction(quickDisable: true, steps: [ObsTransition()]);

    var result = await RunAsync(f, action);

    Assert.Equal(ActionRunStatus.Succeeded, result.Status);
  }

  // ---------------------------------------------------------------------------------------
  // delayMs relative to t0, not cumulative — THE key concurrency test
  // ---------------------------------------------------------------------------------------

  /// <summary>
  /// Blocks each <see cref="DelayAsync"/> call until every expected call has arrived, proving the
  /// steps started concurrently rather than one queueing behind another's delay: a "relative to
  /// the previous step" bug (steps awaited sequentially instead of via <c>Task.WhenAll</c>) means
  /// the second call never arrives while the first is still waiting here, so this fake deadlocks —
  /// and the test times out — instead of a wall-clock timing assertion that could pass by luck.
  /// </summary>
  private sealed class RendezvousDelay(int expectedConcurrentCalls) : IActionDelay, IDisposable
  {
    private readonly SemaphoreSlim _allArrived = new(0);
    private int _arrivals;

    public void Dispose() => _allArrived.Dispose();

    public List<int> RequestedMilliseconds { get; } = [];

    public async Task DelayAsync(int milliseconds, CancellationToken cancellationToken)
    {
      lock (RequestedMilliseconds)
      {
        RequestedMilliseconds.Add(milliseconds);
      }

      if (Interlocked.Increment(ref _arrivals) == expectedConcurrentCalls)
      {
        _ = _allArrived.Release(expectedConcurrentCalls);
      }

      var arrived = await _allArrived.WaitAsync(TimeSpan.FromSeconds(5), cancellationToken);
      if (!arrived)
      {
        throw new TimeoutException(
          "A sibling step's DelayAsync call never arrived within 5s — delays are not relative to t0 (they look cumulative).");
      }
    }
  }

  [Fact]
  public async Task StepsSharingADelayStartConcurrentlyRelativeToInvocationStartNotCumulatively()
  {
    var f = Build();
    using var rendezvousDelay = new RendezvousDelay(expectedConcurrentCalls: 2);
    var executor = new ActionExecutor(
      f.ActionStore, f.MediaResolver, f.HelixClient, f.Mediator, f.TtsPort, f.LlmPort, f.ObsPort, f.MuteGate,
      rendezvousDelay, f.RandomIndexSource, TimeProvider.System, NullLogger<ActionExecutor>.Instance);
    var action = BuildAction(steps: [ObsTransition(delayMs: 2000), ObsTransition(delayMs: 2000)]);
    _ = f.ActionStore.GetByIdAsync(action.Id, Arg.Any<CancellationToken>()).Returns(action);

    var result = await executor.RunActionAsync(action.Id, new TemplateContext(), CancellationToken.None);

    Assert.Equal(ActionRunStatus.Succeeded, result.Status);
    Assert.Equal([2000, 2000], rendezvousDelay.RequestedMilliseconds.Order());
  }

  [Fact]
  public async Task AFailingStepDoesNotAbortItsSiblingStep()
  {
    var f = Build();
    _ = f.HelixClient.SendChatMessageAsync(Arg.Any<TwitchProvider>(), Arg.Any<string>(), Arg.Any<string?>(), Arg.Any<CancellationToken>())
      .Returns(Task.FromException<Result<string>>(new InvalidOperationException("Twitch is down.")));
    var failingStep = SendChat();
    var succeedingStep = ObsTransition();
    var action = BuildAction(steps: [failingStep, succeedingStep]);

    var result = await RunAsync(f, action);

    Assert.Equal(ActionRunStatus.Partial, result.Status);
    var failingResult = Assert.Single(result.Steps, s => s.StepId == failingStep.Id);
    Assert.Equal(ActionStepStatus.Failed, failingResult.Status);
    Assert.Equal("Twitch is down.", failingResult.Detail);
    var succeedingResult = Assert.Single(result.Steps, s => s.StepId == succeedingStep.Id);
    Assert.Equal(ActionStepStatus.Succeeded, succeedingResult.Status);
  }

  // ---------------------------------------------------------------------------------------
  // RollUp
  // ---------------------------------------------------------------------------------------

  [Fact]
  public async Task AllStepsSucceedingRollsUpToSucceeded()
  {
    var f = Build();
    var action = BuildAction(steps: [ObsTransition(), ObsTransition()]);

    var result = await RunAsync(f, action);

    Assert.Equal(ActionRunStatus.Succeeded, result.Status);
  }

  [Fact]
  public async Task AllStepsFailingRollsUpToFailed()
  {
    var f = Build();
    _ = f.HelixClient.SendChatMessageAsync(Arg.Any<TwitchProvider>(), Arg.Any<string>(), Arg.Any<string?>(), Arg.Any<CancellationToken>())
      .Returns(Result.Fail<string>("nope"));
    var action = BuildAction(steps: [SendChat(), SendChat()]);

    var result = await RunAsync(f, action);

    Assert.Equal(ActionRunStatus.Failed, result.Status);
  }

  [Fact]
  public async Task MixedOutcomesRollUpToPartial()
  {
    var f = Build();
    _ = f.HelixClient.SendChatMessageAsync(Arg.Any<TwitchProvider>(), Arg.Any<string>(), Arg.Any<string?>(), Arg.Any<CancellationToken>())
      .Returns(Result.Fail<string>("nope"));
    var action = BuildAction(steps: [SendChat(), ObsTransition()]);

    var result = await RunAsync(f, action);

    Assert.Equal(ActionRunStatus.Partial, result.Status);
  }

  [Fact]
  public async Task AllStepsSkippedRollsUpToSkipped()
  {
    var f = Build();
    var action = BuildAction(steps: [ShowText(template: "   "), ShowText(template: string.Empty)]);

    var result = await RunAsync(f, action);

    Assert.Equal(ActionRunStatus.Skipped, result.Status);
  }

  [Fact]
  public async Task DisabledStepIsSkippedWithoutDispatching()
  {
    var f = Build();
    var action = BuildAction(steps: [ObsTransition(enabled: false)]);

    var result = await RunAsync(f, action);

    var step = Assert.Single(result.Steps);
    Assert.Equal(ActionStepStatus.Skipped, step.Status);
    Assert.Equal("Step is disabled.", step.Detail);
    Assert.Empty(f.ObsPort.ReceivedCalls());
  }

  // ---------------------------------------------------------------------------------------
  // show_text
  // ---------------------------------------------------------------------------------------

  [Fact]
  public async Task ShowTextBlankTemplateSkipsWithoutEmitting()
  {
    var f = Build();
    var action = BuildAction(steps: [ShowText(template: "   ")]);

    var result = await RunAsync(f, action);

    var step = Assert.Single(result.Steps);
    Assert.Equal(ActionStepStatus.Skipped, step.Status);
    Assert.Equal("The text template rendered empty.", step.Detail);
    await f.Mediator.DidNotReceive().Publish(Arg.Any<OverlayTextBroadcastNotification>(), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task ShowTextEmitsTheResolvedOverlayTextPlayback()
  {
    var f = Build();
    var action = BuildAction(steps: [ShowText(template: "Welcome {actor}!", style: TextStyle.Toast, durationMs: 4000, tone: "gold")]);

    var result = await RunAsync(f, action, new TemplateContext { Actor = "Sorlus" });

    Assert.Equal(ActionRunStatus.Succeeded, result.Status);
    await f.Mediator.Received(1).Publish(
      Arg.Is<OverlayTextBroadcastNotification>(n =>
        n.Playback.Text == "Welcome Sorlus!" && n.Playback.DurationMs == 4000 && n.Playback.Style == TextStyle.Toast && n.Playback.Tone == "gold"),
      Arg.Any<CancellationToken>());
  }

  // ---------------------------------------------------------------------------------------
  // play_media
  // ---------------------------------------------------------------------------------------

  [Fact]
  public async Task PlayMediaAllUnavailableSkipsWithoutEmitting()
  {
    var f = Build();
    var assetId = Guid.NewGuid();
    _ = f.MediaResolver.ResolveForPlaybackAsync(assetId, Arg.Any<CancellationToken>()).Returns((MediaAsset?)null);
    var action = BuildAction(steps: [PlayMedia([assetId])]);

    var result = await RunAsync(f, action);

    var step = Assert.Single(result.Steps);
    Assert.Equal(ActionStepStatus.Skipped, step.Status);
    Assert.Equal("No media asset for this step is available.", step.Detail);
    await f.Mediator.DidNotReceive().Publish(Arg.Any<MediaPlayBroadcastNotification>(), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task PlayMediaRandomSelectionIsClampedToTheResolvedRange()
  {
    var f = Build();
    var id1 = Guid.NewGuid();
    var id2 = Guid.NewGuid();
    var id3 = Guid.NewGuid();
    _ = f.MediaResolver.ResolveForPlaybackAsync(id1, Arg.Any<CancellationToken>()).Returns(BuildMediaAsset(id1, src: "one.mp3"));
    _ = f.MediaResolver.ResolveForPlaybackAsync(id2, Arg.Any<CancellationToken>()).Returns(BuildMediaAsset(id2, src: "two.mp3"));
    _ = f.MediaResolver.ResolveForPlaybackAsync(id3, Arg.Any<CancellationToken>()).Returns(BuildMediaAsset(id3, src: "three.mp3"));
    // Deliberately out of [0, 3) — the executor must clamp rather than index out of bounds.
    _ = f.RandomIndexSource.NextIndex(3).Returns(99);
    var action = BuildAction(steps: [PlayMedia([id1, id2, id3], selection: MediaSelection.Random)]);

    var result = await RunAsync(f, action);

    Assert.Equal(ActionRunStatus.Succeeded, result.Status);
    await f.Mediator.Received(1).Publish(Arg.Is<MediaPlayBroadcastNotification>(n => n.Playback.Src == "three.mp3"), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task PlayMediaVolumeOverrideWinsOverTheAssetsOwnVolume()
  {
    var f = Build();
    var assetId = Guid.NewGuid();
    _ = f.MediaResolver.ResolveForPlaybackAsync(assetId, Arg.Any<CancellationToken>()).Returns(BuildMediaAsset(assetId, volume: 0.8));
    var action = BuildAction(steps: [PlayMedia([assetId], volume: 0.3)]);

    var result = await RunAsync(f, action);

    Assert.Equal(ActionRunStatus.Succeeded, result.Status);
    await f.Mediator.Received(1).Publish(Arg.Is<MediaPlayBroadcastNotification>(n => n.Playback.Volume == 0.3), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task PlayMediaWithNoVolumeOverrideUsesTheAssetsOwnVolume()
  {
    var f = Build();
    var assetId = Guid.NewGuid();
    _ = f.MediaResolver.ResolveForPlaybackAsync(assetId, Arg.Any<CancellationToken>()).Returns(BuildMediaAsset(assetId, volume: 0.65));
    var action = BuildAction(steps: [PlayMedia([assetId])]);

    _ = await RunAsync(f, action);

    await f.Mediator.Received(1).Publish(Arg.Is<MediaPlayBroadcastNotification>(n => n.Playback.Volume == 0.65), Arg.Any<CancellationToken>());
  }

  // ---------------------------------------------------------------------------------------
  // send_chat
  // ---------------------------------------------------------------------------------------

  [Fact]
  public async Task SendChatWithUserSenderUsesTheBroadcasterProvider()
  {
    var f = Build();
    var action = BuildAction(steps: [SendChat(sender: ChatSender.User)]);

    var result = await RunAsync(f, action);

    Assert.Equal(ActionRunStatus.Succeeded, result.Status);
    _ = await f.HelixClient.Received(1)
      .SendChatMessageAsync(TwitchProvider.Broadcaster, Arg.Any<string>(), Arg.Any<string?>(), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task SendChatWithBotSenderUsesTheBotProvider()
  {
    var f = Build();
    var action = BuildAction(steps: [SendChat(sender: ChatSender.Bot)]);

    _ = await RunAsync(f, action);

    _ = await f.HelixClient.Received(1)
      .SendChatMessageAsync(TwitchProvider.Bot, Arg.Any<string>(), Arg.Any<string?>(), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task SendChatHelixResultFailMarksTheStepFailed()
  {
    var f = Build();
    _ = f.HelixClient.SendChatMessageAsync(Arg.Any<TwitchProvider>(), Arg.Any<string>(), Arg.Any<string?>(), Arg.Any<CancellationToken>())
      .Returns(Result.Fail<string>("AutoMod held the message."));
    var action = BuildAction(steps: [SendChat()]);

    var result = await RunAsync(f, action);

    var step = Assert.Single(result.Steps);
    Assert.Equal(ActionStepStatus.Failed, step.Status);
    Assert.Equal("AutoMod held the message.", step.Detail);
    Assert.Equal(ActionRunStatus.Failed, result.Status);
  }

  // ---------------------------------------------------------------------------------------
  // twitch_timeout — out-of-range/blank seconds falls back to the default rather than failing
  // ---------------------------------------------------------------------------------------

  [Fact]
  public async Task TimeoutOutOfRangeSecondsFallsBackToTheDefaultRatherThanFailing()
  {
    var f = Build();
    var action = BuildAction(steps: [Timeout(secondsTemplate: "99999999999")]);

    var result = await RunAsync(f, action);

    Assert.Equal(ActionRunStatus.Succeeded, result.Status);
    _ = await f.HelixClient.Received(1)
      .BanOrTimeoutAsync(Arg.Any<string>(), ActionValidation.DefaultTimeoutSeconds, Arg.Any<string?>(), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task TimeoutBlankRenderedSecondsFallsBackToTheDefault()
  {
    var f = Build();
    // {arg9} is out of range against an empty Args list, so it renders empty.
    var action = BuildAction(steps: [Timeout(secondsTemplate: "{arg9}")]);

    _ = await RunAsync(f, action);

    _ = await f.HelixClient.Received(1)
      .BanOrTimeoutAsync(Arg.Any<string>(), ActionValidation.DefaultTimeoutSeconds, Arg.Any<string?>(), Arg.Any<CancellationToken>());
  }

  // ---------------------------------------------------------------------------------------
  // Moderation steps resolve login -> id, then call Helix
  // ---------------------------------------------------------------------------------------

  [Fact]
  public async Task ShoutoutNormalizesAndResolvesTheLoginThenCallsHelix()
  {
    var f = Build();
    _ = f.HelixClient.ResolveUserIdAsync("bob", Arg.Any<CancellationToken>()).Returns(Result.Ok("user-123"));
    var action = BuildAction(steps: [Shoutout(loginTemplate: "  @Bob  ")]);

    var result = await RunAsync(f, action);

    Assert.Equal(ActionRunStatus.Succeeded, result.Status);
    _ = await f.HelixClient.Received(1).ResolveUserIdAsync("bob", Arg.Any<CancellationToken>());
    _ = await f.HelixClient.Received(1).SendShoutoutAsync("user-123", Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task ShoutoutResolveFailureMarksTheStepFailedWithoutCallingShoutout()
  {
    var f = Build();
    _ = f.HelixClient.ResolveUserIdAsync("ghost", Arg.Any<CancellationToken>()).Returns(Result.Fail<string>("No such user."));
    var action = BuildAction(steps: [Shoutout(loginTemplate: "ghost")]);

    var result = await RunAsync(f, action);

    var step = Assert.Single(result.Steps);
    Assert.Equal(ActionStepStatus.Failed, step.Status);
    Assert.Equal("No such user.", step.Detail);
    _ = await f.HelixClient.DidNotReceive().SendShoutoutAsync(Arg.Any<string>(), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task ShoutoutBlankTargetSkipsWithoutCallingHelix()
  {
    var f = Build();
    var action = BuildAction(steps: [Shoutout(loginTemplate: "   ")]);

    var result = await RunAsync(f, action);

    var step = Assert.Single(result.Steps);
    Assert.Equal(ActionStepStatus.Skipped, step.Status);
    _ = await f.HelixClient.DidNotReceive().ResolveUserIdAsync(Arg.Any<string>(), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task WhisperResolvesTheLoginThenCallsHelixWithTheRenderedMessage()
  {
    var f = Build();
    _ = f.HelixClient.ResolveUserIdAsync("bob", Arg.Any<CancellationToken>()).Returns(Result.Ok("user-123"));
    var action = BuildAction(steps: [Whisper(loginTemplate: "bob", template: "hey {arg1}")]);

    var result = await RunAsync(f, action, new TemplateContext { Args = ["there"] });

    Assert.Equal(ActionRunStatus.Succeeded, result.Status);
    _ = await f.HelixClient.Received(1).SendWhisperAsync("user-123", "hey there", Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task BanResolvesTheLoginThenCallsBanOrTimeoutWithANullDuration()
  {
    var f = Build();
    _ = f.HelixClient.ResolveUserIdAsync("bob", Arg.Any<CancellationToken>()).Returns(Result.Ok("user-123"));
    var action = BuildAction(steps: [Ban(loginTemplate: "bob", reasonTemplate: "spam")]);

    var result = await RunAsync(f, action);

    Assert.Equal(ActionRunStatus.Succeeded, result.Status);
    _ = await f.HelixClient.Received(1).BanOrTimeoutAsync("user-123", null, "spam", Arg.Any<CancellationToken>());
  }

  // ---------------------------------------------------------------------------------------
  // tts_speak / llm_response / obs_scene
  // ---------------------------------------------------------------------------------------

  [Fact]
  public async Task TtsSpeakCallsThePortWithTheRenderedText()
  {
    var f = Build();
    var action = BuildAction(steps: [new TtsSpeakActionStep { Id = Guid.NewGuid(), Template = "Hello {actor}" }]);

    var result = await RunAsync(f, action, new TemplateContext { Actor = "Sorlus" });

    Assert.Equal(ActionRunStatus.Succeeded, result.Status);
    await f.TtsPort.Received(1).SpeakAsync("Hello Sorlus", Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task LlmResponseBlankAnswerSkipsWithoutSendingChat()
  {
    var f = Build();
    _ = f.LlmPort.AskAsync(Arg.Any<TemplateContext>(), Arg.Any<string>(), Arg.Any<CancellationToken>()).Returns(string.Empty);
    var action = BuildAction(steps: [new LlmResponseActionStep { Id = Guid.NewGuid(), Template = "What's up?" }]);

    var result = await RunAsync(f, action);

    var step = Assert.Single(result.Steps);
    Assert.Equal(ActionStepStatus.Skipped, step.Status);
    _ = await f.HelixClient.DidNotReceive()
      .SendChatMessageAsync(Arg.Any<TwitchProvider>(), Arg.Any<string>(), Arg.Any<string?>(), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task LlmResponseSendsTheAnswerAsTheBot()
  {
    var f = Build();
    _ = f.LlmPort.AskAsync(Arg.Any<TemplateContext>(), Arg.Any<string>(), Arg.Any<CancellationToken>()).Returns("42");
    var action = BuildAction(steps: [new LlmResponseActionStep { Id = Guid.NewGuid(), Template = "What's up?" }]);

    var result = await RunAsync(f, action);

    Assert.Equal(ActionRunStatus.Succeeded, result.Status);
    _ = await f.HelixClient.Received(1).SendChatMessageAsync(TwitchProvider.Bot, "42", Arg.Any<string?>(), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task ObsSceneCallsSwitchSceneWithTheConfiguredName()
  {
    var f = Build();
    var action = BuildAction(steps: [new ObsSceneActionStep { Id = Guid.NewGuid(), SceneName = "Gameplay" }]);

    var result = await RunAsync(f, action);

    Assert.Equal(ActionRunStatus.Succeeded, result.Status);
    await f.ObsPort.Received(1).SwitchSceneAsync("Gameplay", Arg.Any<CancellationToken>());
  }
}
