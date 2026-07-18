using System.Globalization;

using FluentResults;

using MediatR;

using Microsoft.Extensions.Logging;

using Narya.Core.Actions;
using Narya.Core.Media;
using Narya.Twitch;
using Narya.Twitch.Helix;

namespace Narya.Application.Actions;

/// <summary>
/// Runs an <see cref="AutomationAction"/>'s steps — a port of legacy's <c>createActionExecutor</c>/
/// <c>runAction</c>/<c>runStep</c>/<c>dispatch</c> (<c>legacy/src/server/actionExecutor.ts</c>).
///
/// <para>
/// <b><c>DelayMs</c> is relative to the invocation's start (t0), never cumulative:</b>
/// <see cref="RunActionAsync"/> starts every step as an independent task via
/// <c>Task.WhenAll(action.Steps.Select(RunStepAsync))</c> — the LINQ projection begins each step's
/// async state machine (and, inside it, the step's own <see cref="IActionDelay.DelayAsync"/> call)
/// before <c>WhenAll</c> ever awaits anything, so two steps sharing <c>DelayMs = 2000</c> both
/// start waiting at essentially the same instant rather than one queueing behind the other's
/// dispatch. This is what lets a banner, a clip, and a TTS line configured with the same delay land
/// together instead of stacking. <c>ActionExecutorTests</c>'s delay-ordering test proves this with a
/// rendezvous fake (<c>IActionDelay</c> that blocks each call until every expected call has
/// arrived) rather than real-time timing, which would be flaky.
/// </para>
///
/// <para>
/// <b>A step's failure never aborts its siblings:</b> <see cref="RunStepAsync"/> wraps its own
/// delay + dispatch in a try/catch and converts any exception into a <c>failed</c>
/// <see cref="ActionStepResult"/> rather than letting it propagate into the shared
/// <c>Task.WhenAll</c> (which would fault the whole run the moment ANY task faults). This is one of
/// the two deliberate, documented exceptions to this codebase's no-blanket-catch rule (the other is
/// the Task 6 trigger dispatcher's per-invocation catch) — see the Phase 4 plan's Global
/// Constraints. <see cref="OperationCanceledException"/> triggered by the caller's own
/// <see cref="CancellationToken"/> is re-thrown rather than swallowed, matching
/// <c>RealtimeBridgeHandler{T}</c>'s carve-out: a step reporting itself "failed" because the HTTP
/// request that triggered it was aborted would be misleading telemetry.
/// </para>
///
/// <para>
/// <b>The quickDisable/mute check runs exactly once, before any step:</b> matches legacy's
/// <c>runAction</c> — a muted, opt-in Action's run is <c>skipped</c> with an EMPTY steps list, so it
/// broadcasts nothing at all (no <c>media:play</c>, no <c>overlay:text</c>), independent of which
/// source (reward, command, manual run, module lifecycle) invoked it.
/// </para>
/// </summary>
public sealed partial class ActionExecutor(
  IActionStore actionStore,
  IMediaResolver mediaResolver,
  IHelixClient helixClient,
  IMediator mediator,
  ITtsPort ttsPort,
  ILlmPort llmPort,
  IObsPort obsPort,
  IMediaMuteGate muteGate,
  IActionDelay delay,
  IRandomIndexSource randomIndexSource,
  TimeProvider timeProvider,
  ILogger<ActionExecutor> logger) : IActionExecutor
{
  private readonly record struct StepOutcome(ActionStepStatus Status, string Detail);

  private static readonly StepOutcome Succeeded = new(ActionStepStatus.Succeeded, string.Empty);

  public async Task<ActionRunResult> RunActionAsync(Guid actionId, TemplateContext context, CancellationToken cancellationToken)
  {
    var ranAt = timeProvider.GetUtcNow();
    var action = await actionStore.GetByIdAsync(actionId, cancellationToken).ConfigureAwait(false);

    // A missing or disabled Action broadcasts nothing at all.
    if (action?.Enabled != true)
    {
      return new ActionRunResult(actionId, ActionRunStatus.Skipped, [], ranAt);
    }

    // Master media mute: an opted-in Action is skipped silently while muted. This is the single
    // choke point, so every invocation source (command, reward, manual, module) honors it
    // uniformly, and a skipped run broadcasts nothing (no media:play, no overlay:text), so
    // overlays stay quiet with no new play path.
    if (action.QuickDisable && await muteGate.IsMutedAsync(cancellationToken).ConfigureAwait(false))
    {
      return new ActionRunResult(actionId, ActionRunStatus.Skipped, [], ranAt);
    }

    var results = await Task.WhenAll(action.Steps.Select(step => RunStepAsync(step, context, cancellationToken)))
      .ConfigureAwait(false);
    return new ActionRunResult(actionId, RollUp(results), results, ranAt);
  }

  /// <summary>
  /// <c>delayMs</c> is relative to the start of the invocation, not to the previous step — see
  /// this type's doc comment. A step that throws is contained here and never aborts the rest.
  /// Pending delays live only in this process — a restart drops them rather than replaying
  /// time-sensitive steps against a stream that has moved on.
  /// </summary>
  private async Task<ActionStepResult> RunStepAsync(ActionStep step, TemplateContext context, CancellationToken cancellationToken)
  {
    if (!step.Enabled)
    {
      return ToResult(step, Skipped("Step is disabled."));
    }

    try
    {
      if (step.DelayMs > 0)
      {
        await delay.DelayAsync(step.DelayMs, cancellationToken).ConfigureAwait(false);
      }

      return ToResult(step, await DispatchAsync(step, context, cancellationToken).ConfigureAwait(false));
    }
    catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
    {
      throw;
    }
    catch (Exception ex)
    {
      LogStepFailed(logger, step.Id, StepTypeName(step), ex);
      return ToResult(step, Failed(ErrorDetail(ex)));
    }
  }

  /// <summary>
  /// One arm per step type, each delegating to its own dedicated method — kept as a plain
  /// (non-async) switch expression, not an <c>async</c> method with a case-by-case body, so no
  /// case needs its own block braces just to scope a local variable.
  /// </summary>
  private Task<StepOutcome> DispatchAsync(ActionStep step, TemplateContext context, CancellationToken cancellationToken) => step switch
  {
    ShowTextActionStep s => DispatchShowTextAsync(s, context, cancellationToken),
    PlayMediaActionStep s => DispatchPlayMediaAsync(s, context, cancellationToken),
    TtsSpeakActionStep s => DispatchTtsSpeakAsync(s, context, cancellationToken),
    SendChatActionStep s => DispatchSendChatAsync(s, context, cancellationToken),
    LlmResponseActionStep s => DispatchLlmResponseAsync(s, context, cancellationToken),
    ObsSceneActionStep s => DispatchObsSceneAsync(s, cancellationToken),
    ObsTransitionActionStep => DispatchObsTransitionAsync(cancellationToken),
    TwitchShoutoutActionStep s => DispatchShoutoutAsync(s, context, cancellationToken),
    TwitchWhisperActionStep s => DispatchWhisperAsync(s, context, cancellationToken),
    TwitchTimeoutActionStep s => DispatchTimeoutAsync(s, context, cancellationToken),
    TwitchBanActionStep s => DispatchBanAsync(s, context, cancellationToken),
    _ => throw new NotSupportedException($"Unsupported action step type: {step.GetType()}."),
  };

  private async Task<StepOutcome> DispatchShowTextAsync(ShowTextActionStep step, TemplateContext context, CancellationToken cancellationToken)
  {
    var text = ActionTemplate.Render(step.Template, context);
    if (string.IsNullOrWhiteSpace(text))
    {
      return Skipped("The text template rendered empty.");
    }

    // Only the resolved playback goes on the wire — the overlay is a public browser source and
    // must never see the operator's Action configuration.
    var playback = new OverlayTextPlayback(Guid.NewGuid(), text, step.DurationMs, step.Style, step.Tone);
    await mediator.Publish(new OverlayTextBroadcastNotification(playback), cancellationToken).ConfigureAwait(false);
    return Succeeded;
  }

  private async Task<StepOutcome> DispatchPlayMediaAsync(PlayMediaActionStep step, TemplateContext context, CancellationToken cancellationToken)
  {
    var asset = await PickAssetAsync(step.AssetIds, step.Selection, cancellationToken).ConfigureAwait(false);
    if (asset is null)
    {
      return Skipped("No media asset for this step is available.");
    }

    var volume = step.Volume ?? asset.Volume;
    var playback = new MediaPlayback(Guid.NewGuid(), asset.Kind, asset.Src, volume, context.Actor);
    await mediator.Publish(new MediaPlayBroadcastNotification(playback), cancellationToken).ConfigureAwait(false);
    return Succeeded;
  }

  private async Task<StepOutcome> DispatchTtsSpeakAsync(TtsSpeakActionStep step, TemplateContext context, CancellationToken cancellationToken)
  {
    var text = ActionTemplate.Render(step.Template, context);
    if (string.IsNullOrWhiteSpace(text))
    {
      return Skipped("The TTS template rendered empty.");
    }

    await ttsPort.SpeakAsync(text, cancellationToken).ConfigureAwait(false);
    return Succeeded;
  }

  private async Task<StepOutcome> DispatchSendChatAsync(SendChatActionStep step, TemplateContext context, CancellationToken cancellationToken)
  {
    var message = ActionTemplate.Render(step.Template, context);
    return string.IsNullOrWhiteSpace(message)
      ? Skipped("The chat template rendered empty.")
      : await SendChatAsync(step.Sender, message, cancellationToken).ConfigureAwait(false);
  }

  private async Task<StepOutcome> DispatchLlmResponseAsync(LlmResponseActionStep step, TemplateContext context, CancellationToken cancellationToken)
  {
    var prompt = ActionTemplate.Render(step.Template, context);
    if (string.IsNullOrWhiteSpace(prompt))
    {
      return Skipped("The LLM prompt rendered empty.");
    }

    var answer = await llmPort.AskAsync(context, prompt, cancellationToken).ConfigureAwait(false);
    return string.IsNullOrWhiteSpace(answer)
      ? Skipped("The LLM returned no text.")
      : await SendChatAsync(ChatSender.Bot, answer, cancellationToken).ConfigureAwait(false);
  }

  private async Task<StepOutcome> DispatchObsSceneAsync(ObsSceneActionStep step, CancellationToken cancellationToken)
  {
    await obsPort.SwitchSceneAsync(step.SceneName, cancellationToken).ConfigureAwait(false);
    return Succeeded;
  }

  private async Task<StepOutcome> DispatchObsTransitionAsync(CancellationToken cancellationToken)
  {
    await obsPort.TransitionAsync(cancellationToken).ConfigureAwait(false);
    return Succeeded;
  }

  private async Task<StepOutcome> DispatchShoutoutAsync(TwitchShoutoutActionStep step, TemplateContext context, CancellationToken cancellationToken)
  {
    var login = NormalizeLogin(ActionTemplate.Render(step.LoginTemplate, context));
    return login.Length == 0
      ? Skipped("The shoutout target rendered empty.")
      : await ResolveThenAsync(login, helixClient.SendShoutoutAsync, cancellationToken).ConfigureAwait(false);
  }

  private async Task<StepOutcome> DispatchWhisperAsync(TwitchWhisperActionStep step, TemplateContext context, CancellationToken cancellationToken)
  {
    var login = NormalizeLogin(ActionTemplate.Render(step.LoginTemplate, context));
    if (login.Length == 0)
    {
      return Skipped("The whisper target rendered empty.");
    }

    var message = ActionTemplate.Render(step.Template, context);
    return string.IsNullOrWhiteSpace(message)
      ? Skipped("The whisper template rendered empty.")
      : await ResolveThenAsync(login, (id, ct) => helixClient.SendWhisperAsync(id, message, ct), cancellationToken).ConfigureAwait(false);
  }

  private async Task<StepOutcome> DispatchTimeoutAsync(TwitchTimeoutActionStep step, TemplateContext context, CancellationToken cancellationToken)
  {
    var login = NormalizeLogin(ActionTemplate.Render(step.LoginTemplate, context));
    if (login.Length == 0)
    {
      return Skipped("The timeout target rendered empty.");
    }

    var seconds = RenderTimeoutSeconds(step.SecondsTemplate, context);
    var reason = ActionTemplate.Render(step.ReasonTemplate, context);
    return await ResolveThenAsync(login, (id, ct) => helixClient.BanOrTimeoutAsync(id, seconds, reason, ct), cancellationToken)
      .ConfigureAwait(false);
  }

  private async Task<StepOutcome> DispatchBanAsync(TwitchBanActionStep step, TemplateContext context, CancellationToken cancellationToken)
  {
    var login = NormalizeLogin(ActionTemplate.Render(step.LoginTemplate, context));
    if (login.Length == 0)
    {
      return Skipped("The ban target rendered empty.");
    }

    var reason = ActionTemplate.Render(step.ReasonTemplate, context);
    return await ResolveThenAsync(login, (id, ct) => helixClient.BanOrTimeoutAsync(id, null, reason, ct), cancellationToken)
      .ConfigureAwait(false);
  }

  private async Task<MediaAsset?> PickAssetAsync(IReadOnlyList<Guid> assetIds, MediaSelection selection, CancellationToken cancellationToken)
  {
    var available = new List<MediaAsset>(assetIds.Count);
    foreach (var id in assetIds)
    {
      // IMediaResolver.ResolveForPlaybackAsync is THE single choke point: null for unknown,
      // disabled, or unavailable, so nothing here has to re-check those flags.
      var asset = await mediaResolver.ResolveForPlaybackAsync(id, cancellationToken).ConfigureAwait(false);
      if (asset is not null)
      {
        available.Add(asset);
      }
    }

    if (available.Count == 0)
    {
      return null;
    }

    if (selection == MediaSelection.First)
    {
      return available[0];
    }

    // Clamped: a chooser must never index past the assets that actually resolved.
    var index = Math.Clamp(randomIndexSource.NextIndex(available.Count), 0, available.Count - 1);
    return available[index];
  }

  private async Task<StepOutcome> SendChatAsync(ChatSender sender, string message, CancellationToken cancellationToken)
  {
    var provider = sender == ChatSender.User ? TwitchProvider.Broadcaster : TwitchProvider.Bot;
    var result = await helixClient.SendChatMessageAsync(provider, message, cancellationToken: cancellationToken)
      .ConfigureAwait(false);
    return FromResult(result);
  }

  /// <summary>
  /// Every moderation step (shoutout/whisper/timeout/ban) needs a Twitch user id, but templates
  /// only carry a login — this resolves login→id via <see cref="IHelixClient.ResolveUserIdAsync"/>
  /// first, then runs <paramref name="action"/> with the resolved id. A Helix
  /// <see cref="Result"/> failure — whether from resolution or the action itself — maps to a
  /// FAILED step rather than throwing, matching every other Helix call here.
  /// </summary>
  private async Task<StepOutcome> ResolveThenAsync(
    string login, Func<string, CancellationToken, Task<Result>> action, CancellationToken cancellationToken)
  {
    var resolved = await helixClient.ResolveUserIdAsync(login, cancellationToken).ConfigureAwait(false);
    if (resolved.IsFailed)
    {
      return Failed(FirstError(resolved));
    }

    var result = await action(resolved.Value, cancellationToken).ConfigureAwait(false);
    return FromResult(result);
  }

  private static StepOutcome FromResult(ResultBase result) => result.IsFailed ? Failed(FirstError(result)) : Succeeded;

  private static string FirstError(ResultBase result) =>
    result.Errors.Count > 0 ? result.Errors[0].Message : "The Twitch request failed.";

  /// <summary>
  /// A timeout duration bound from the invocation (<c>{arg2}</c> in <c>/timeout bob 300 spam</c>)
  /// may render empty, non-numeric, or out of range — chat and the command bar are both free-form.
  /// Falls back to the default rather than failing the step: a moderation command that lands with
  /// the wrong duration beats one that does not land at all.
  /// </summary>
  private static int RenderTimeoutSeconds(string template, TemplateContext context)
  {
    var rendered = ActionTemplate.Render(template, context).Trim();
    if (!double.TryParse(rendered, NumberStyles.Float, CultureInfo.InvariantCulture, out var value) || !double.IsFinite(value))
    {
      return ActionValidation.DefaultTimeoutSeconds;
    }

    var seconds = (int)Math.Round(value, MidpointRounding.AwayFromZero);
    return seconds is >= 1 and <= ActionValidation.MaxTimeoutSeconds ? seconds : ActionValidation.DefaultTimeoutSeconds;
  }

  /// <summary>Logins arrive from templates, so "@Sorlus" and "Sorlus" must both work.</summary>
  private static string NormalizeLogin(string value) => value.Trim().TrimStart('@').Trim().ToLowerInvariant();

  private static string ErrorDetail(Exception exception) =>
    string.IsNullOrEmpty(exception.Message) ? exception.GetType().Name : exception.Message;

  private static StepOutcome Skipped(string detail) => new(ActionStepStatus.Skipped, detail);

  private static StepOutcome Failed(string detail) => new(ActionStepStatus.Failed, detail);

  private static ActionStepResult ToResult(ActionStep step, StepOutcome outcome) =>
    new(step.Id, StepTypeName(step), outcome.Status, outcome.Detail);

  private static ActionRunStatus RollUp(IReadOnlyList<ActionStepResult> steps)
  {
    var ran = steps.Where(s => s.Status != ActionStepStatus.Skipped).ToList();
    return ran.Count switch
    {
      0 => ActionRunStatus.Skipped,
      _ when ran.All(s => s.Status == ActionStepStatus.Succeeded) => ActionRunStatus.Succeeded,
      _ when ran.All(s => s.Status == ActionStepStatus.Failed) => ActionRunStatus.Failed,
      _ => ActionRunStatus.Partial,
    };
  }

  /// <summary>
  /// The same lowercase-snake-case discriminator <see cref="ActionStepJsonConverter"/> uses on the
  /// wire — kept in sync with it by hand (both switch over the same 11 sealed record types).
  /// </summary>
  private static string StepTypeName(ActionStep step) => step switch
  {
    ShowTextActionStep => "show_text",
    PlayMediaActionStep => "play_media",
    TtsSpeakActionStep => "tts_speak",
    SendChatActionStep => "send_chat",
    LlmResponseActionStep => "llm_response",
    ObsSceneActionStep => "obs_scene",
    ObsTransitionActionStep => "obs_transition",
    TwitchShoutoutActionStep => "twitch_shoutout",
    TwitchWhisperActionStep => "twitch_whisper",
    TwitchTimeoutActionStep => "twitch_timeout",
    TwitchBanActionStep => "twitch_ban",
    _ => step.GetType().Name,
  };

  [LoggerMessage(Level = LogLevel.Error, Message = "Action step {StepId} ({StepType}) failed")]
  private static partial void LogStepFailed(ILogger logger, Guid stepId, string stepType, Exception exception);
}
