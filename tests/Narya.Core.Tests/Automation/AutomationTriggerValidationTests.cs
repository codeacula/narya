using Narya.Core.Automation;

namespace Narya.Core.Tests.Automation;

/// <summary>
/// Pure unit tests for <see cref="AutomationTriggerValidation.Normalize"/> — a port of legacy's
/// <c>normalizeAutomationTriggerInput</c> test coverage
/// (<c>legacy/src/server/automationTriggers.test.ts</c>). No document store involved — the
/// <c>actionId</c>/<c>moduleId</c> existence checks live in
/// <c>Narya.Database.Automation.AutomationTriggerStore</c> instead (Testcontainers-covered in
/// <c>Narya.Database.Tests.Automation.AutomationTriggerStoreTests</c>), mirroring
/// <c>Narya.Core.Tests.Actions.ActionValidationTests</c>.
/// </summary>
public sealed class AutomationTriggerValidationTests
{
  private static AutomationTriggerUpsert Upsert(TriggerConfig? config = null, int? globalCooldownMs = null, int? userCooldownMs = null) => new()
  {
    ActionId = Guid.NewGuid(),
    Config = config ?? new ChatPhraseTriggerConfig { Phrase = "hype", Match = ChatPhraseMatch.Contains },
    GlobalCooldownMs = globalCooldownMs,
    UserCooldownMs = userCooldownMs,
  };

  // ---------------------------------------------------------------------------------------
  // Missing config ("unsupported kind" — see TriggerConfig's doc comment for why an
  // inconsistent kind/config pair cannot be constructed at all, unlike legacy's string kind).
  // ---------------------------------------------------------------------------------------

  [Fact]
  public void NullConfigFails()
  {
    var result = AutomationTriggerValidation.Normalize(Upsert() with { Config = null });

    Assert.True(result.IsFailed);
    Assert.Contains(result.Errors, e => e.Message.Contains("Unsupported trigger kind", StringComparison.Ordinal));
  }

  // ---------------------------------------------------------------------------------------
  // Cooldowns
  // ---------------------------------------------------------------------------------------

  [Fact]
  public void AbsentCooldownsDefaultToTheSharedConstants()
  {
    var result = AutomationTriggerValidation.Normalize(Upsert());

    Assert.True(result.IsSuccess);
    Assert.Equal(AutomationTriggerValidation.DefaultGlobalCooldownMs, result.Value.GlobalCooldownMs);
    Assert.Equal(AutomationTriggerValidation.DefaultUserCooldownMs, result.Value.UserCooldownMs);
  }

  [Fact]
  public void ExplicitZeroCooldownIsKeptRatherThanFallingBackToTheDefault()
  {
    var result = AutomationTriggerValidation.Normalize(Upsert(globalCooldownMs: 0, userCooldownMs: 0));

    Assert.True(result.IsSuccess);
    Assert.Equal(0, result.Value.GlobalCooldownMs);
    Assert.Equal(0, result.Value.UserCooldownMs);
  }

  [Fact]
  public void NegativeGlobalCooldownFails()
  {
    var result = AutomationTriggerValidation.Normalize(Upsert(globalCooldownMs: -1));

    Assert.True(result.IsFailed);
    Assert.Contains(result.Errors, e => e.Message.Contains("Cooldowns", StringComparison.Ordinal));
  }

  [Fact]
  public void NegativeUserCooldownFails()
  {
    var result = AutomationTriggerValidation.Normalize(Upsert(userCooldownMs: -1));

    Assert.True(result.IsFailed);
    Assert.Contains(result.Errors, e => e.Message.Contains("Cooldowns", StringComparison.Ordinal));
  }

  [Fact]
  public void CooldownAboveTwentyFourHoursIsCappedRatherThanRejected()
  {
    var result = AutomationTriggerValidation.Normalize(Upsert(globalCooldownMs: AutomationTriggerValidation.MaxCooldownMs + 1_000));

    Assert.True(result.IsSuccess);
    Assert.Equal(AutomationTriggerValidation.MaxCooldownMs, result.Value.GlobalCooldownMs);
  }

  // ---------------------------------------------------------------------------------------
  // reward
  // ---------------------------------------------------------------------------------------

  [Fact]
  public void RewardMissingRewardIdFails()
  {
    var result = AutomationTriggerValidation.Normalize(Upsert(new RewardTriggerConfig()));

    Assert.True(result.IsFailed);
    Assert.Contains(result.Errors, e => e.Message.Contains("reward id", StringComparison.Ordinal));
  }

  [Fact]
  public void RewardWithARewardIdSucceedsAndDerivesTheRewardKind()
  {
    var result = AutomationTriggerValidation.Normalize(Upsert(new RewardTriggerConfig { RewardId = " reward-123 " }));

    Assert.True(result.IsSuccess);
    Assert.Equal(AutomationTriggerKind.Reward, result.Value.Kind);
    var config = Assert.IsType<RewardTriggerConfig>(result.Value.Config);
    Assert.Equal("reward-123", config.RewardId); // trimmed
  }

  // ---------------------------------------------------------------------------------------
  // twitch_event
  // ---------------------------------------------------------------------------------------

  [Fact]
  public void TwitchEventWithAnOutOfRangeCastEventKindFails()
  {
    var result = AutomationTriggerValidation.Normalize(Upsert(new TwitchEventTriggerConfig { EventKind = (TwitchAlertEventKind)999 }));

    Assert.True(result.IsFailed);
    Assert.Contains(result.Errors, e => e.Message.Contains("Twitch event kind", StringComparison.Ordinal));
  }

  [Theory]
  [InlineData(TwitchAlertEventKind.Sub)]
  [InlineData(TwitchAlertEventKind.Gift)]
  [InlineData(TwitchAlertEventKind.Cheer)]
  [InlineData(TwitchAlertEventKind.Raid)]
  [InlineData(TwitchAlertEventKind.Follow)]
  public void EverySupportedEventKindSucceeds(TwitchAlertEventKind kind)
  {
    var result = AutomationTriggerValidation.Normalize(Upsert(new TwitchEventTriggerConfig { EventKind = kind }));

    Assert.True(result.IsSuccess);
    Assert.Equal(AutomationTriggerKind.TwitchEvent, result.Value.Kind);
  }

  // ---------------------------------------------------------------------------------------
  // chat_phrase
  // ---------------------------------------------------------------------------------------

  [Fact]
  public void ChatPhraseEmptyPhraseFails()
  {
    var result = AutomationTriggerValidation.Normalize(Upsert(new ChatPhraseTriggerConfig { Phrase = "   ", Match = ChatPhraseMatch.Contains }));

    Assert.True(result.IsFailed);
    Assert.Contains(result.Errors, e => e.Message.Contains("phrase", StringComparison.Ordinal));
  }

  [Fact]
  public void ChatPhraseOutOfRangeCastMatchFails()
  {
    var result = AutomationTriggerValidation.Normalize(Upsert(new ChatPhraseTriggerConfig { Phrase = "hype", Match = (ChatPhraseMatch)999 }));

    Assert.True(result.IsFailed);
    Assert.Contains(result.Errors, e => e.Message.Contains("match", StringComparison.Ordinal));
  }

  [Fact]
  public void ChatPhraseRolesAreDedupedAndOrderPreserved()
  {
    var result = AutomationTriggerValidation.Normalize(Upsert(new ChatPhraseTriggerConfig
    {
      Phrase = "hype",
      Match = ChatPhraseMatch.Exact,
      Roles = [TriggerRole.Mod, TriggerRole.Vip, TriggerRole.Mod],
    }));

    Assert.True(result.IsSuccess);
    var config = Assert.IsType<ChatPhraseTriggerConfig>(result.Value.Config);
    Assert.Equal([TriggerRole.Mod, TriggerRole.Vip], config.Roles);
  }

  [Fact]
  public void ChatPhraseWithNoRolesDefaultsToEmptyMeaningEveryone()
  {
    var result = AutomationTriggerValidation.Normalize(Upsert(new ChatPhraseTriggerConfig { Phrase = " Hype ", Match = ChatPhraseMatch.Exact }));

    Assert.True(result.IsSuccess);
    var config = Assert.IsType<ChatPhraseTriggerConfig>(result.Value.Config);
    Assert.Equal("Hype", config.Phrase); // trimmed, case preserved
    Assert.Empty(config.Roles);
  }

  // ---------------------------------------------------------------------------------------
  // viewer_command — !command normalization, aliases (cap, self-exclusion, dedup)
  // ---------------------------------------------------------------------------------------

  [Theory]
  [InlineData("Hype", "!hype")]
  [InlineData("!hype", "!hype")]
  [InlineData("!HYPE", "!hype")]
  [InlineData("  hype  ", "!hype")]
  public void ViewerCommandNormalizesToALowercaseBangCommand(string input, string expected)
  {
    var result = AutomationTriggerValidation.Normalize(Upsert(new ViewerCommandTriggerConfig { Command = input }));

    Assert.True(result.IsSuccess);
    Assert.Equal(AutomationTriggerKind.ViewerCommand, result.Value.Kind);
    var config = Assert.IsType<ViewerCommandTriggerConfig>(result.Value.Config);
    Assert.Equal(expected, config.Command);
  }

  [Fact]
  public void ViewerCommandWithASpaceFails()
  {
    var result = AutomationTriggerValidation.Normalize(Upsert(new ViewerCommandTriggerConfig { Command = "!two words" }));

    Assert.True(result.IsFailed);
    Assert.Contains(result.Errors, e => e.Message.Contains("Commands", StringComparison.Ordinal));
  }

  [Fact]
  public void ViewerCommandAliasesAreNormalizedDedupedAndExcludeTheCommandItself()
  {
    var result = AutomationTriggerValidation.Normalize(Upsert(new ViewerCommandTriggerConfig
    {
      Command = "Hype",
      Aliases = ["!H", "!hype", "!h"], // "!hype" == the command itself; "!H"/"!h" are duplicates
    }));

    Assert.True(result.IsSuccess);
    var config = Assert.IsType<ViewerCommandTriggerConfig>(result.Value.Config);
    Assert.Equal(["!h"], config.Aliases);
  }

  [Fact]
  public void ViewerCommandOverFiveAliasesFails()
  {
    var result = AutomationTriggerValidation.Normalize(Upsert(new ViewerCommandTriggerConfig
    {
      Command = "hype",
      Aliases = ["a", "b", "c", "d", "e", "f"],
    }));

    Assert.True(result.IsFailed);
    Assert.Contains(result.Errors, e => e.Message.Contains("aliases", StringComparison.Ordinal));
  }

  // ---------------------------------------------------------------------------------------
  // dashboard_slash — same command normalization, "/" prefix, no roles
  // ---------------------------------------------------------------------------------------

  [Fact]
  public void DashboardSlashNormalizesToALowercaseSlashCommand()
  {
    var result = AutomationTriggerValidation.Normalize(Upsert(new DashboardSlashTriggerConfig { Command = "Shoutout", Aliases = ["SO"] }));

    Assert.True(result.IsSuccess);
    Assert.Equal(AutomationTriggerKind.DashboardSlash, result.Value.Kind);
    var config = Assert.IsType<DashboardSlashTriggerConfig>(result.Value.Config);
    Assert.Equal("/shoutout", config.Command);
    Assert.Equal(["/so"], config.Aliases);
  }

  [Fact]
  public void DashboardSlashEmptyCommandFails()
  {
    var result = AutomationTriggerValidation.Normalize(Upsert(new DashboardSlashTriggerConfig { Command = "/" }));

    Assert.True(result.IsFailed);
    Assert.Contains(result.Errors, e => e.Message.Contains("Commands", StringComparison.Ordinal));
  }

  // ---------------------------------------------------------------------------------------
  // manual
  // ---------------------------------------------------------------------------------------

  [Fact]
  public void ManualEmptyLabelFails()
  {
    var result = AutomationTriggerValidation.Normalize(Upsert(new ManualTriggerConfig { Label = "" }));

    Assert.True(result.IsFailed);
    Assert.Contains(result.Errors, e => e.Message.Contains("label", StringComparison.Ordinal));
  }

  [Fact]
  public void ManualWithALabelSucceeds()
  {
    var result = AutomationTriggerValidation.Normalize(Upsert(new ManualTriggerConfig { Label = "Intermission" }));

    Assert.True(result.IsSuccess);
    Assert.Equal(AutomationTriggerKind.Manual, result.Value.Kind);
  }

  // ---------------------------------------------------------------------------------------
  // module_activate / module_deactivate — no fields to validate
  // ---------------------------------------------------------------------------------------

  [Fact]
  public void ModuleActivateSucceedsWithNoFields()
  {
    var result = AutomationTriggerValidation.Normalize(Upsert(new ModuleActivateTriggerConfig()));

    Assert.True(result.IsSuccess);
    Assert.Equal(AutomationTriggerKind.ModuleActivate, result.Value.Kind);
  }

  [Fact]
  public void ModuleDeactivateSucceedsWithNoFields()
  {
    var result = AutomationTriggerValidation.Normalize(Upsert(new ModuleDeactivateTriggerConfig()));

    Assert.True(result.IsSuccess);
    Assert.Equal(AutomationTriggerKind.ModuleDeactivate, result.Value.Kind);
  }
}
