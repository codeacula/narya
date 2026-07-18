using Narya.Core.Actions;

namespace Narya.Core.Tests.Actions;

/// <summary>
/// Pure unit tests for <see cref="ActionValidation.Normalize"/> — a port of legacy's
/// <c>normalizeActionUpsert</c>/<c>normalizeSteps</c>/<c>normalizeStepPayload</c> test coverage
/// (<c>legacy/src/server/actions.ts:108-284</c>). No document store involved, mirroring
/// <c>Narya.Core.Tests.Media.MediaAssetValidationTests</c>.
/// </summary>
public sealed class ActionValidationTests
{
  private static ActionUpsert BuildUpsert(params ActionStep[] steps) => new()
  {
    Name = "Hype Train",
    Description = "Plays a clip.",
    Steps = steps,
  };

  // ---------------------------------------------------------------------------------------
  // Name / description
  // ---------------------------------------------------------------------------------------

  [Fact]
  public void EmptyNameFails()
  {
    var upsert = BuildUpsert(new ObsTransitionActionStep()) with { Name = "   " };

    var result = ActionValidation.Normalize(upsert);

    Assert.True(result.IsFailed);
    Assert.Contains(result.Errors, e => e.Message == "Action name is required.");
  }

  [Fact]
  public void NameIsTrimmed()
  {
    var upsert = BuildUpsert(new ObsTransitionActionStep()) with { Name = "  Hype Train  " };

    var result = ActionValidation.Normalize(upsert);

    Assert.True(result.IsSuccess);
    Assert.Equal("Hype Train", result.Value.Name);
  }

  [Fact]
  public void NameOverMaxLengthFails()
  {
    var upsert = BuildUpsert(new ObsTransitionActionStep()) with { Name = new string('a', ActionValidation.MaxNameLength + 1) };

    var result = ActionValidation.Normalize(upsert);

    Assert.True(result.IsFailed);
  }

  [Fact]
  public void DescriptionOverMaxLengthIsTruncatedRatherThanRejected()
  {
    var upsert = BuildUpsert(new ObsTransitionActionStep()) with { Description = new string('d', ActionValidation.MaxDescriptionLength + 50) };

    var result = ActionValidation.Normalize(upsert);

    Assert.True(result.IsSuccess);
    Assert.Equal(ActionValidation.MaxDescriptionLength, result.Value.Description.Length);
  }

  // ---------------------------------------------------------------------------------------
  // Step array bounds
  // ---------------------------------------------------------------------------------------

  [Fact]
  public void NoStepsFails()
  {
    var upsert = BuildUpsert();

    var result = ActionValidation.Normalize(upsert);

    Assert.True(result.IsFailed);
    Assert.Contains(result.Errors, e => e.Message == "At least one step is required.");
  }

  [Fact]
  public void MoreThanMaxStepsFails()
  {
    var steps = Enumerable.Range(0, ActionValidation.MaxSteps + 1).Select(_ => (ActionStep)new ObsTransitionActionStep()).ToArray();
    var upsert = BuildUpsert(steps);

    var result = ActionValidation.Normalize(upsert);

    Assert.True(result.IsFailed);
    Assert.Contains(result.Errors, e => e.Message == $"Actions can have at most {ActionValidation.MaxSteps} steps.");
  }

  [Fact]
  public void ExactlyMaxStepsSucceeds()
  {
    var steps = Enumerable.Range(0, ActionValidation.MaxSteps).Select(_ => (ActionStep)new ObsTransitionActionStep()).ToArray();
    var upsert = BuildUpsert(steps);

    var result = ActionValidation.Normalize(upsert);

    Assert.True(result.IsSuccess);
    Assert.Equal(ActionValidation.MaxSteps, result.Value.Steps.Count);
  }

  // ---------------------------------------------------------------------------------------
  // delayMs (common to every step type)
  // ---------------------------------------------------------------------------------------

  [Theory]
  [InlineData(-1)]
  [InlineData(600_001)]
  public void DelayOutOfRangeFails(int delayMs)
  {
    var upsert = BuildUpsert(new ObsTransitionActionStep { DelayMs = delayMs });

    var result = ActionValidation.Normalize(upsert);

    Assert.True(result.IsFailed);
    Assert.Contains(result.Errors, e => e.Message.StartsWith("Step delay must be", StringComparison.Ordinal));
  }

  [Fact]
  public void DelayAtBoundsSucceeds()
  {
    var upsert = BuildUpsert(new ObsTransitionActionStep { DelayMs = ActionValidation.MaxDelayMs });

    var result = ActionValidation.Normalize(upsert);

    Assert.True(result.IsSuccess);
  }

  // ---------------------------------------------------------------------------------------
  // show_text
  // ---------------------------------------------------------------------------------------

  [Fact]
  public void ShowTextMissingTemplateFails()
  {
    var upsert = BuildUpsert(new ShowTextActionStep { Template = "  ", Style = TextStyle.Banner });

    var result = ActionValidation.Normalize(upsert);

    Assert.True(result.IsFailed);
    Assert.Contains(result.Errors, e => e.Message == "Text steps need a template.");
  }

  [Fact]
  public void ShowTextBadStyleFails()
  {
    var upsert = BuildUpsert(new ShowTextActionStep { Template = "hi", Style = (TextStyle)999 });

    var result = ActionValidation.Normalize(upsert);

    Assert.True(result.IsFailed);
  }

  [Theory]
  [InlineData(0, 1_000)]
  [InlineData(500, 1_000)]
  [InlineData(3_000, 3_000)]
  [InlineData(120_000, 60_000)]
  public void ShowTextDurationClamps(int input, int expected)
  {
    var upsert = BuildUpsert(new ShowTextActionStep { Template = "hi", Style = TextStyle.Banner, DurationMs = input });

    var result = ActionValidation.Normalize(upsert);

    Assert.True(result.IsSuccess);
    Assert.Equal(expected, ((ShowTextActionStep)result.Value.Steps[0]).DurationMs);
  }

  [Fact]
  public void ShowTextToneIsTrimmedAndTruncated()
  {
    var upsert = BuildUpsert(new ShowTextActionStep
    {
      Template = "hi",
      Style = TextStyle.Banner,
      Tone = "  " + new string('t', 40) + "  ",
    });

    var result = ActionValidation.Normalize(upsert);

    Assert.True(result.IsSuccess);
    Assert.Equal(ActionValidation.MaxToneLength, ((ShowTextActionStep)result.Value.Steps[0]).Tone!.Length);
  }

  [Fact]
  public void ShowTextEmptyToneBecomesNull()
  {
    var upsert = BuildUpsert(new ShowTextActionStep { Template = "hi", Style = TextStyle.Banner, Tone = "   " });

    var result = ActionValidation.Normalize(upsert);

    Assert.True(result.IsSuccess);
    Assert.Null(((ShowTextActionStep)result.Value.Steps[0]).Tone);
  }

  // ---------------------------------------------------------------------------------------
  // play_media
  // ---------------------------------------------------------------------------------------

  [Fact]
  public void PlayMediaEmptyAssetIdsFails()
  {
    var upsert = BuildUpsert(new PlayMediaActionStep { AssetIds = [], Selection = MediaSelection.First });

    var result = ActionValidation.Normalize(upsert);

    Assert.True(result.IsFailed);
    Assert.Contains(result.Errors, e => e.Message == "Media steps need at least one asset.");
  }

  [Fact]
  public void PlayMediaTooManyAssetIdsFails()
  {
    var ids = Enumerable.Range(0, ActionValidation.MaxAssetsPerStep + 1).Select(_ => Guid.NewGuid()).ToArray();
    var upsert = BuildUpsert(new PlayMediaActionStep { AssetIds = ids, Selection = MediaSelection.First });

    var result = ActionValidation.Normalize(upsert);

    Assert.True(result.IsFailed);
    Assert.Contains(result.Errors, e => e.Message == $"Media steps can reference at most {ActionValidation.MaxAssetsPerStep} assets.");
  }

  [Fact]
  public void PlayMediaBadSelectionFails()
  {
    var upsert = BuildUpsert(new PlayMediaActionStep { AssetIds = [Guid.NewGuid()], Selection = (MediaSelection)999 });

    var result = ActionValidation.Normalize(upsert);

    Assert.True(result.IsFailed);
  }

  [Fact]
  public void PlayMediaAbsentVolumeStaysNull()
  {
    var upsert = BuildUpsert(new PlayMediaActionStep { AssetIds = [Guid.NewGuid()], Selection = MediaSelection.Random });

    var result = ActionValidation.Normalize(upsert);

    Assert.True(result.IsSuccess);
    Assert.Null(((PlayMediaActionStep)result.Value.Steps[0]).Volume);
  }

  [Theory]
  [InlineData(-1.0, 0.0)]
  [InlineData(1.5, 1.0)]
  [InlineData(0.4, 0.4)]
  public void PlayMediaVolumeClamps(double input, double expected)
  {
    var upsert = BuildUpsert(new PlayMediaActionStep { AssetIds = [Guid.NewGuid()], Selection = MediaSelection.First, Volume = input });

    var result = ActionValidation.Normalize(upsert);

    Assert.True(result.IsSuccess);
    Assert.Equal(expected, ((PlayMediaActionStep)result.Value.Steps[0]).Volume);
  }

  // ---------------------------------------------------------------------------------------
  // tts_speak / llm_response (template-only)
  // ---------------------------------------------------------------------------------------

  [Fact]
  public void TtsSpeakMissingTemplateFails()
  {
    var upsert = BuildUpsert(new TtsSpeakActionStep { Template = "" });

    var result = ActionValidation.Normalize(upsert);

    Assert.True(result.IsFailed);
    Assert.Contains(result.Errors, e => e.Message == "TTS steps need a template.");
  }

  [Fact]
  public void LlmResponseMissingTemplateFails()
  {
    var upsert = BuildUpsert(new LlmResponseActionStep { Template = "" });

    var result = ActionValidation.Normalize(upsert);

    Assert.True(result.IsFailed);
    Assert.Contains(result.Errors, e => e.Message == "LLM steps need a prompt.");
  }

  [Fact]
  public void TemplateOverMaxLengthFails()
  {
    var upsert = BuildUpsert(new TtsSpeakActionStep { Template = new string('t', ActionValidation.MaxTemplateLength + 1) });

    var result = ActionValidation.Normalize(upsert);

    Assert.True(result.IsFailed);
    Assert.Contains(result.Errors, e => e.Message == "Templates must be 500 characters or fewer.");
  }

  // ---------------------------------------------------------------------------------------
  // send_chat
  // ---------------------------------------------------------------------------------------

  [Fact]
  public void SendChatMissingTemplateFails()
  {
    var upsert = BuildUpsert(new SendChatActionStep { Template = "", Sender = ChatSender.Bot });

    var result = ActionValidation.Normalize(upsert);

    Assert.True(result.IsFailed);
    Assert.Contains(result.Errors, e => e.Message == "Chat steps need a message.");
  }

  [Fact]
  public void SendChatBadSenderFails()
  {
    var upsert = BuildUpsert(new SendChatActionStep { Template = "hi", Sender = (ChatSender)999 });

    var result = ActionValidation.Normalize(upsert);

    Assert.True(result.IsFailed);
  }

  // ---------------------------------------------------------------------------------------
  // obs_scene / obs_transition
  // ---------------------------------------------------------------------------------------

  [Fact]
  public void ObsSceneMissingNameFails()
  {
    var upsert = BuildUpsert(new ObsSceneActionStep { SceneName = "   " });

    var result = ActionValidation.Normalize(upsert);

    Assert.True(result.IsFailed);
    Assert.Contains(result.Errors, e => e.Message == "OBS scene steps need a scene name.");
  }

  [Fact]
  public void ObsSceneNameOverMaxLengthFails()
  {
    var upsert = BuildUpsert(new ObsSceneActionStep { SceneName = new string('s', ActionValidation.MaxSceneNameLength + 1) });

    var result = ActionValidation.Normalize(upsert);

    Assert.True(result.IsFailed);
  }

  [Fact]
  public void ObsTransitionHasNoPayloadToValidateAndSucceeds()
  {
    var upsert = BuildUpsert(new ObsTransitionActionStep());

    var result = ActionValidation.Normalize(upsert);

    Assert.True(result.IsSuccess);
  }

  // ---------------------------------------------------------------------------------------
  // twitch_shoutout / twitch_whisper / twitch_ban (loginTemplate required)
  // ---------------------------------------------------------------------------------------

  [Fact]
  public void ShoutoutMissingLoginFails()
  {
    var upsert = BuildUpsert(new TwitchShoutoutActionStep { LoginTemplate = "" });

    var result = ActionValidation.Normalize(upsert);

    Assert.True(result.IsFailed);
    Assert.Contains(result.Errors, e => e.Message == "Shoutout steps need a target login.");
  }

  [Fact]
  public void WhisperMissingMessageFails()
  {
    var upsert = BuildUpsert(new TwitchWhisperActionStep { LoginTemplate = "{arg1}", Template = "" });

    var result = ActionValidation.Normalize(upsert);

    Assert.True(result.IsFailed);
    Assert.Contains(result.Errors, e => e.Message == "Whisper steps need a message.");
  }

  [Fact]
  public void BanOptionalReasonDefaultsToEmpty()
  {
    var upsert = BuildUpsert(new TwitchBanActionStep { LoginTemplate = "{arg1}" });

    var result = ActionValidation.Normalize(upsert);

    Assert.True(result.IsSuccess);
    Assert.Equal(string.Empty, ((TwitchBanActionStep)result.Value.Steps[0]).ReasonTemplate);
  }

  // ---------------------------------------------------------------------------------------
  // twitch_timeout — the literal-vs-templated secondsTemplate range check
  // ---------------------------------------------------------------------------------------

  [Theory]
  [InlineData("0")]
  [InlineData("-5")]
  [InlineData("1209601")]
  [InlineData("not-a-number")]
  public void TimeoutLiteralSecondsOutOfRangeFails(string secondsTemplate)
  {
    var upsert = BuildUpsert(new TwitchTimeoutActionStep { LoginTemplate = "{arg1}", SecondsTemplate = secondsTemplate });

    var result = ActionValidation.Normalize(upsert);

    Assert.True(result.IsFailed);
    Assert.Contains(result.Errors, e => e.Message == "Timeout duration must be between 1 second and 14 days.");
  }

  [Theory]
  [InlineData("1")]
  [InlineData("600")]
  [InlineData("1209600")]
  public void TimeoutLiteralSecondsInRangeSucceeds(string secondsTemplate)
  {
    var upsert = BuildUpsert(new TwitchTimeoutActionStep { LoginTemplate = "{arg1}", SecondsTemplate = secondsTemplate });

    var result = ActionValidation.Normalize(upsert);

    Assert.True(result.IsSuccess);
  }

  [Fact]
  public void TimeoutTemplatedSecondsSkipsTheRangeCheck()
  {
    // "{arg2}" could render to anything at invocation time — the executor (Task 3) is the only
    // place that can range-check it, so save-time validation must not reject it here even though
    // it is not itself a number in range.
    var upsert = BuildUpsert(new TwitchTimeoutActionStep { LoginTemplate = "{arg1}", SecondsTemplate = "{arg2}" });

    var result = ActionValidation.Normalize(upsert);

    Assert.True(result.IsSuccess);
    Assert.Equal("{arg2}", ((TwitchTimeoutActionStep)result.Value.Steps[0]).SecondsTemplate);
  }

  [Fact]
  public void TimeoutMissingDurationFails()
  {
    var upsert = BuildUpsert(new TwitchTimeoutActionStep { LoginTemplate = "{arg1}", SecondsTemplate = "  " });

    var result = ActionValidation.Normalize(upsert);

    Assert.True(result.IsFailed);
    Assert.Contains(result.Errors, e => e.Message == "Timeout steps need a duration.");
  }

  // ---------------------------------------------------------------------------------------
  // Unsupported action step (defensive default arm)
  // ---------------------------------------------------------------------------------------

  private sealed record UnknownActionStep : ActionStep;

  [Fact]
  public void UnrecognizedStepTypeFails()
  {
    var upsert = BuildUpsert(new UnknownActionStep());

    var result = ActionValidation.Normalize(upsert);

    Assert.True(result.IsFailed);
    Assert.Contains(result.Errors, e => e.Message == "Unsupported action step.");
  }
}
