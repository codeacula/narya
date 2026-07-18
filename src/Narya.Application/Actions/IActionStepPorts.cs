namespace Narya.Application.Actions;

/// <summary>
/// This file collects <c>ActionExecutor</c>'s injected capability ports that are NOT already an
/// existing Narya interface (contrast with <c>Narya.Core.Media.IMediaResolver</c>,
/// <c>Narya.Twitch.Helix.IHelixClient</c>, and <c>MediatR.IMediator</c>, which the executor takes
/// directly). Two families:
///
/// <list type="bullet">
/// <item>
/// <description>
/// <b>Capabilities Phase 4 does not build yet</b> (<see cref="ITtsPort"/>, <see cref="ILlmPort"/>,
/// <see cref="IObsPort"/>, <see cref="IMediaMuteGate"/>): each gets a MINIMAL no-op default,
/// registered via <c>TryAddSingleton</c> in <c>Narya.Application.ServiceCollectionExtensions</c>
/// (unguarded — no infrastructure dependency), so a <c>tts_speak</c>/<c>llm_response</c>/
/// <c>obs_scene</c>/<c>obs_transition</c> step — or the <c>quickDisable</c> mute check — never
/// crashes the executor before its real companion (Phase 5 for TTS/OBS, Phase 8 for the LLM and
/// the media-mute store proper — Phase 4 Task 4) replaces the default with a plain
/// <c>AddSingleton</c>, which always wins the last-registration-wins rule over these
/// <c>TryAddSingleton</c> defaults (same pattern as <c>Narya.Core.Media.NullMediaFileCatalog</c>).
/// A step dispatched against a no-op AWAITS it and then proceeds exactly like legacy does — legacy
/// always awaits its own <c>speakText</c>/<c>switchObsScene</c>/<c>triggerObsTransition</c> deps
/// too — so <see cref="ITtsPort"/>/<see cref="IObsPort"/> no-ops make their step SUCCEED (nothing
/// to fail on); <see cref="ILlmPort"/>'s no-op returns an empty answer, which the executor's
/// existing blank-answer check already turns into a skipped step (not a fabricated success).
/// </description>
/// </item>
/// <item>
/// <description>
/// <b>Testability seams for otherwise-nondeterministic behavior</b> (<see cref="IActionDelay"/>,
/// <see cref="IRandomIndexSource"/>): real defaults (<see cref="SystemActionDelay"/>,
/// <see cref="SystemRandomIndexSource"/>) are registered the same unguarded
/// <c>TryAddSingleton</c> way — they need no infrastructure either — so no
/// <c>WebApplicationFactory</c> test fixture needs to substitute them just to satisfy DI
/// validation; only <c>Narya.Application.Tests.Actions.ActionExecutorTests</c> substitutes
/// controlled fakes to make delay-ordering and random-selection assertions deterministic. The
/// executor's <c>ranAt</c>/clock seam reuses the ALREADY-registered <see cref="TimeProvider"/>
/// (<c>services.TryAddSingleton(TimeProvider.System)</c> in
/// <c>Narya.Application.ServiceCollectionExtensions</c>) rather than inventing a fourth
/// single-purpose interface.
/// </description>
/// </item>
/// </list>
/// </summary>
public interface ITtsPort
{
  Task SpeakAsync(string text, CancellationToken cancellationToken);
}

/// <summary>
/// No-op default — see this file's top-of-file doc comment. Registered
/// <c>TryAddSingleton&lt;ITtsPort, NoopTtsPort&gt;</c>; Phase 5's Chatterbox-backed companion
/// implementation replaces it with a plain <c>AddSingleton</c>.
/// </summary>
public sealed class NoopTtsPort : ITtsPort
{
  public Task SpeakAsync(string text, CancellationToken cancellationToken) => Task.CompletedTask;
}

public interface ILlmPort
{
  /// <summary>Returns the model's answer, or an empty string if it produced nothing usable.</summary>
  Task<string> AskAsync(TemplateContext context, string prompt, CancellationToken cancellationToken);
}

/// <summary>
/// No-op default — see this file's top-of-file doc comment. An empty answer makes the calling
/// <c>llm_response</c> step skip (via <c>ActionExecutor</c>'s existing blank-answer check) rather
/// than posting a fabricated chat message. Registered <c>TryAddSingleton&lt;ILlmPort, NoopLlmPort&gt;</c>;
/// Phase 8's real implementation replaces it with a plain <c>AddSingleton</c>.
/// </summary>
public sealed class NoopLlmPort : ILlmPort
{
  public Task<string> AskAsync(TemplateContext context, string prompt, CancellationToken cancellationToken) =>
    Task.FromResult(string.Empty);
}

public interface IObsPort
{
  Task SwitchSceneAsync(string sceneName, CancellationToken cancellationToken);

  Task TransitionAsync(CancellationToken cancellationToken);
}

/// <summary>
/// No-op default — see this file's top-of-file doc comment. Registered
/// <c>TryAddSingleton&lt;IObsPort, NoopObsPort&gt;</c>; Phase 5's OBS-WebSocket-backed companion
/// implementation replaces it with a plain <c>AddSingleton</c>.
/// </summary>
public sealed class NoopObsPort : IObsPort
{
  public Task SwitchSceneAsync(string sceneName, CancellationToken cancellationToken) => Task.CompletedTask;

  public Task TransitionAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}

/// <summary>
/// The master media-mute check (legacy's Stream Controls "quick disable"): when
/// <c>Narya.Core.Actions.AutomationAction.QuickDisable</c> is set, <c>ActionExecutor</c>
/// checks this ONCE at the top of a run and, if muted, skips the WHOLE run without dispatching any
/// step — see <c>ActionExecutor.RunActionAsync</c>'s doc comment.
/// </summary>
public interface IMediaMuteGate
{
  Task<bool> IsMutedAsync(CancellationToken cancellationToken);
}

/// <summary>
/// No-op default — never muted. See this file's top-of-file doc comment. Registered
/// <c>TryAddSingleton&lt;IMediaMuteGate, NoopMediaMuteGate&gt;</c>; Phase 4 Task 4's
/// <c>IMediaMuteStore</c>-backed implementation (single-row mute flag +
/// <c>media:mute</c> broadcast) replaces it with a plain <c>AddSingleton</c>.
/// </summary>
public sealed class NoopMediaMuteGate : IMediaMuteGate
{
  public Task<bool> IsMutedAsync(CancellationToken cancellationToken) => Task.FromResult(false);
}

/// <summary>
/// The <c>delayMs</c> seam — see this file's top-of-file doc comment. <c>ActionExecutor</c> awaits
/// this directly instead of calling <see cref="Task.Delay(int, CancellationToken)"/> so a test can
/// substitute a controllable fake to prove delays are relative to the invocation's start (t0), not
/// cumulative across steps, without a real multi-second test run.
/// </summary>
public interface IActionDelay
{
  Task DelayAsync(int milliseconds, CancellationToken cancellationToken);
}

/// <summary>Real default — see this file's top-of-file doc comment.</summary>
public sealed class SystemActionDelay : IActionDelay
{
  public Task DelayAsync(int milliseconds, CancellationToken cancellationToken) =>
    Task.Delay(milliseconds, cancellationToken);
}

/// <summary>
/// The <c>play_media</c> random-selection seam — see this file's top-of-file doc comment.
/// </summary>
public interface IRandomIndexSource
{
  /// <summary>An index in <c>[0, exclusiveUpperBound)</c>. <c>ActionExecutor</c> still clamps the result defensively.</summary>
  int NextIndex(int exclusiveUpperBound);
}

/// <summary>Real default — see this file's top-of-file doc comment.</summary>
public sealed class SystemRandomIndexSource : IRandomIndexSource
{
  public int NextIndex(int exclusiveUpperBound) => Random.Shared.Next(exclusiveUpperBound);
}
