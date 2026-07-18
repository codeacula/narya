using FluentResults;

namespace Narya.Core.Actions;

/// <summary>
/// The fully-normalized values <see cref="ActionValidation.Normalize"/> produces from an
/// <see cref="ActionUpsert"/> — ready to persist. <see cref="Steps"/>'s <c>Id</c>/<c>Position</c>
/// are whatever the input carried (irrelevant — <c>Narya.Database.Actions.ActionStore</c> always
/// overwrites both on save; see <see cref="ActionStep"/>'s doc comment).
/// </summary>
public sealed record NormalizedAction(string Name, string Description, bool Enabled, bool QuickDisable, IReadOnlyList<ActionStep> Steps);

/// <summary>
/// Resolves an <see cref="ActionUpsert"/> (POST/PUT body) into a fully valid
/// <see cref="NormalizedAction"/> — a port of legacy's <c>normalizeActionUpsert</c>/
/// <c>normalizeSteps</c>/<c>normalizeStepPayload</c> (<c>legacy/src/server/actions.ts:108-284</c>).
///
/// Deliberately a plain static method rather than a MediatR/FluentValidation pipeline, mirroring
/// <c>Narya.Core.Media.MediaAssetValidation</c>'s reasoning: per-step-type dispatch is genuinely
/// procedural (an 11-way switch over sealed step types), not a flat set of declarative bounds
/// checks. <c>Narya.Database.Actions.ActionStore</c> is the only caller — this lives in
/// Narya.Core rather than Narya.Database so it stays testable without a document store.
///
/// <para>
/// <b>Enum defaulting note:</b> legacy treats an omitted/invalid <c>style</c>/<c>selection</c>/
/// <c>sender</c> string as a validation failure ("Unsupported text style: unknown."). Here, those
/// fields are real C# enums bound by System.Text.Json — an omitted JSON property simply leaves
/// the enum at its zero-valued member (<see cref="TextStyle.Banner"/>/<see cref="MediaSelection.First"/>/
/// <see cref="ChatSender.User"/>) rather than failing to bind, and an unrecognized JSON string
/// fails model binding (400) before this method ever runs. <see cref="Enum.IsDefined"/> below still
/// guards the case a caller constructs a step with an out-of-range cast value directly (e.g. tests),
/// which is the one way an invalid enum reaches this method.
/// </para>
/// </summary>
public static class ActionValidation
{
  public const int MaxSteps = 20;
  public const int MaxNameLength = 120;
  public const int MaxDescriptionLength = 500;
  public const int MaxTemplateLength = 500;
  public const int MaxDelayMs = 600_000;
  public const int MinTextDurationMs = 1_000;
  public const int MaxTextDurationMs = 60_000;
  public const int MaxAssetsPerStep = 25;
  public const int MaxToneLength = 24;
  public const int MaxSceneNameLength = 160;

  /// <summary>Twitch's ceiling: 14 days. Matches legacy's <c>MAX_TIMEOUT_SECONDS</c>.</summary>
  public const int MaxTimeoutSeconds = 1_209_600;

  /// <summary>
  /// Not used by save-time validation (a templated <c>secondsTemplate</c> skips the literal-range
  /// check here) — exported for Phase 4 Task 3's executor, which falls back to this when a
  /// rendered timeout duration is blank or non-numeric. Matches legacy's
  /// <c>DEFAULT_TIMEOUT_SECONDS</c>.
  /// </summary>
  public const int DefaultTimeoutSeconds = 600;

  public static Result<NormalizedAction> Normalize(ActionUpsert upsert)
  {
    var name = (upsert.Name ?? string.Empty).Trim();
    if (name.Length == 0)
    {
      return Result.Fail<NormalizedAction>("Action name is required.");
    }

    if (name.Length > MaxNameLength)
    {
      return Result.Fail<NormalizedAction>($"Action names must be {MaxNameLength} characters or fewer.");
    }

    var description = (upsert.Description ?? string.Empty).Trim();
    if (description.Length > MaxDescriptionLength)
    {
      description = description[..MaxDescriptionLength];
    }

    var stepsResult = NormalizeSteps(upsert.Steps);
    return stepsResult.IsFailed
      ? Result.Fail<NormalizedAction>(stepsResult.Errors)
      : Result.Ok(new NormalizedAction(name, description, upsert.Enabled, upsert.QuickDisable, stepsResult.Value));
  }

  private static Result<IReadOnlyList<ActionStep>> NormalizeSteps(IReadOnlyList<ActionStep>? steps)
  {
    var list = steps ?? [];
    if (list.Count == 0)
    {
      return Result.Fail<IReadOnlyList<ActionStep>>("At least one step is required.");
    }

    if (list.Count > MaxSteps)
    {
      return Result.Fail<IReadOnlyList<ActionStep>>($"Actions can have at most {MaxSteps} steps.");
    }

    var normalized = new List<ActionStep>(list.Count);
    foreach (var step in list)
    {
      var result = NormalizeStep(step);
      if (result.IsFailed)
      {
        return Result.Fail<IReadOnlyList<ActionStep>>(result.Errors);
      }

      normalized.Add(result.Value);
    }

    return Result.Ok<IReadOnlyList<ActionStep>>(normalized);
  }

  private static Result<ActionStep> NormalizeStep(ActionStep step) =>
    step.DelayMs is < 0 or > MaxDelayMs
      ? Result.Fail<ActionStep>($"Step delay must be between 0 and {MaxDelayMs} ms.")
      : step switch
      {
        ShowTextActionStep s => NormalizeShowText(s),
        PlayMediaActionStep s => NormalizePlayMedia(s),
        TtsSpeakActionStep s => NormalizeTtsSpeak(s),
        SendChatActionStep s => NormalizeSendChat(s),
        LlmResponseActionStep s => NormalizeLlmResponse(s),
        ObsSceneActionStep s => NormalizeObsScene(s),
        ObsTransitionActionStep => Result.Ok(step),
        TwitchShoutoutActionStep s => NormalizeShoutout(s),
        TwitchWhisperActionStep s => NormalizeWhisper(s),
        TwitchTimeoutActionStep s => NormalizeTimeout(s),
        TwitchBanActionStep s => NormalizeBan(s),
        _ => Result.Fail<ActionStep>("Unsupported action step."),
      };

  private static Result<ActionStep> NormalizeShowText(ShowTextActionStep step)
  {
    var templateResult = RequireTemplate(step.Template, "Text steps need a template.");
    if (templateResult.IsFailed)
    {
      return Result.Fail<ActionStep>(templateResult.Errors);
    }

    if (!Enum.IsDefined(step.Style))
    {
      return Result.Fail<ActionStep>($"Unsupported text style: {step.Style}.");
    }

    var durationMs = Math.Clamp(step.DurationMs, MinTextDurationMs, MaxTextDurationMs);
    var tone = NormalizeTone(step.Tone);

    return Result.Ok<ActionStep>(step with { Template = templateResult.Value, DurationMs = durationMs, Tone = tone });
  }

  private static Result<ActionStep> NormalizePlayMedia(PlayMediaActionStep step)
  {
    var assetIds = step.AssetIds ?? [];
    if (assetIds.Count == 0)
    {
      return Result.Fail<ActionStep>("Media steps need at least one asset.");
    }

    if (assetIds.Count > MaxAssetsPerStep)
    {
      return Result.Fail<ActionStep>($"Media steps can reference at most {MaxAssetsPerStep} assets.");
    }

    if (!Enum.IsDefined(step.Selection))
    {
      return Result.Fail<ActionStep>($"Unsupported media selection: {step.Selection}.");
    }

    // Absent volume means "use the asset's own volume" — not the same as an explicit 0 — so it
    // stays null rather than defaulting (matches legacy's undefined-preserving behavior).
    var volume = step.Volume is { } v && double.IsFinite(v) ? Math.Clamp(v, 0, 1) : (double?)null;

    return Result.Ok<ActionStep>(step with { Volume = volume });
  }

  private static Result<ActionStep> NormalizeTtsSpeak(TtsSpeakActionStep step)
  {
    var templateResult = RequireTemplate(step.Template, "TTS steps need a template.");
    return templateResult.IsFailed
      ? Result.Fail<ActionStep>(templateResult.Errors)
      : Result.Ok<ActionStep>(step with { Template = templateResult.Value });
  }

  private static Result<ActionStep> NormalizeSendChat(SendChatActionStep step)
  {
    var templateResult = RequireTemplate(step.Template, "Chat steps need a message.");
    return (templateResult.IsFailed, Enum.IsDefined(step.Sender)) switch
    {
      (true, _) => Result.Fail<ActionStep>(templateResult.Errors),
      (_, false) => Result.Fail<ActionStep>($"Unsupported chat sender: {step.Sender}."),
      _ => Result.Ok<ActionStep>(step with { Template = templateResult.Value }),
    };
  }

  private static Result<ActionStep> NormalizeLlmResponse(LlmResponseActionStep step)
  {
    var templateResult = RequireTemplate(step.Template, "LLM steps need a prompt.");
    return templateResult.IsFailed
      ? Result.Fail<ActionStep>(templateResult.Errors)
      : Result.Ok<ActionStep>(step with { Template = templateResult.Value });
  }

  private static Result<ActionStep> NormalizeObsScene(ObsSceneActionStep step)
  {
    var sceneName = (step.SceneName ?? string.Empty).Trim();
    return sceneName.Length switch
    {
      0 => Result.Fail<ActionStep>("OBS scene steps need a scene name."),
      > MaxSceneNameLength => Result.Fail<ActionStep>($"OBS scene names must be {MaxSceneNameLength} characters or fewer."),
      _ => Result.Ok<ActionStep>(step with { SceneName = sceneName }),
    };
  }

  private static Result<ActionStep> NormalizeShoutout(TwitchShoutoutActionStep step)
  {
    var loginResult = RequireLoginTemplate(step.LoginTemplate, "Shoutout");
    return loginResult.IsFailed
      ? Result.Fail<ActionStep>(loginResult.Errors)
      : Result.Ok<ActionStep>(step with { LoginTemplate = loginResult.Value });
  }

  private static Result<ActionStep> NormalizeWhisper(TwitchWhisperActionStep step)
  {
    var loginResult = RequireLoginTemplate(step.LoginTemplate, "Whisper");
    if (loginResult.IsFailed)
    {
      return Result.Fail<ActionStep>(loginResult.Errors);
    }

    var templateResult = RequireTemplate(step.Template, "Whisper steps need a message.");
    return templateResult.IsFailed
      ? Result.Fail<ActionStep>(templateResult.Errors)
      : Result.Ok<ActionStep>(step with { LoginTemplate = loginResult.Value, Template = templateResult.Value });
  }

  private static Result<ActionStep> NormalizeTimeout(TwitchTimeoutActionStep step)
  {
    var loginResult = RequireLoginTemplate(step.LoginTemplate, "Timeout");
    if (loginResult.IsFailed)
    {
      return Result.Fail<ActionStep>(loginResult.Errors);
    }

    var secondsTemplate = (step.SecondsTemplate ?? string.Empty).Trim();
    if (secondsTemplate.Length == 0)
    {
      return Result.Fail<ActionStep>("Timeout steps need a duration.");
    }

    if (secondsTemplate.Length > MaxTemplateLength)
    {
      return Result.Fail<ActionStep>("Templates must be 500 characters or fewer.");
    }

    // A template (contains `{`), so `/timeout bob 300 spam` can bind the duration per invocation.
    // A literal duration ("600") is range-checked here; anything templated can only be
    // range-checked at render time, in the executor (Phase 4 Task 3).
    if (!secondsTemplate.Contains('{'))
    {
      if (!double.TryParse(secondsTemplate, out var literal) || !double.IsFinite(literal) || literal < 1 || literal > MaxTimeoutSeconds)
      {
        return Result.Fail<ActionStep>("Timeout duration must be between 1 second and 14 days.");
      }
    }

    var reasonTemplate = OptionalTemplate(step.ReasonTemplate);
    return Result.Ok<ActionStep>(step with
    {
      LoginTemplate = loginResult.Value,
      SecondsTemplate = secondsTemplate,
      ReasonTemplate = reasonTemplate,
    });
  }

  private static Result<ActionStep> NormalizeBan(TwitchBanActionStep step)
  {
    var loginResult = RequireLoginTemplate(step.LoginTemplate, "Ban");
    if (loginResult.IsFailed)
    {
      return Result.Fail<ActionStep>(loginResult.Errors);
    }

    var reasonTemplate = OptionalTemplate(step.ReasonTemplate);
    return Result.Ok<ActionStep>(step with { LoginTemplate = loginResult.Value, ReasonTemplate = reasonTemplate });
  }

  private static Result<string> RequireTemplate(string? value, string message)
  {
    var template = (value ?? string.Empty).Trim();
    return template.Length switch
    {
      0 => Result.Fail<string>(message),
      > MaxTemplateLength => Result.Fail<string>("Templates must be 500 characters or fewer."),
      _ => Result.Ok(template),
    };
  }

  /// <summary>
  /// Legacy's <c>requireLoginTemplate</c> shares <see cref="RequireTemplate"/>'s length-cap
  /// message verbatim — a dedicated label swaps only the "is required" half.
  /// </summary>
  private static Result<string> RequireLoginTemplate(string? value, string label) =>
    RequireTemplate(value, $"{label} steps need a target login.");

  private static string OptionalTemplate(string? value)
  {
    var template = (value ?? string.Empty).Trim();
    return template.Length > MaxTemplateLength ? template[..MaxTemplateLength] : template;
  }

  private static string? NormalizeTone(string? tone)
  {
    var trimmed = (tone ?? string.Empty).Trim();
    return trimmed.Length switch
    {
      0 => null,
      > MaxToneLength => trimmed[..MaxToneLength],
      _ => trimmed,
    };
  }
}
