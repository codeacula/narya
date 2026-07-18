using System.Text.RegularExpressions;

using FluentResults;

namespace Narya.Core.Automation;

/// <summary>
/// Resolves an <see cref="AutomationTriggerUpsert"/> (POST/PUT body) into a fully valid
/// <see cref="NormalizedAutomationTrigger"/> — a port of legacy's <c>normalizeAutomationTriggerInput</c>
/// (<c>legacy/src/server/automationTriggers.ts:109-237</c>), minus the <c>actionId</c>/<c>moduleId</c>
/// existence checks: those need I/O (<c>Narya.Database.Automation.AutomationTriggerStore</c> performs
/// them), so this class stays infrastructure-free and independently testable, mirroring
/// <c>Narya.Core.Actions.ActionValidation</c>'s division of labor with
/// <c>Narya.Database.Actions.ActionStore</c>.
/// </summary>
public static partial class AutomationTriggerValidation
{
  public const int MaxPhraseLength = 200;
  public const int MaxLabelLength = 120;
  public const int MaxAliases = 5;

  /// <summary>24h — a cooldown longer than a stream is a typo.</summary>
  public const int MaxCooldownMs = 86_400_000;

  public const int MaxRewardIdLength = 120;

  /// <summary>Default cooldowns for a new trigger. Zero (explicitly supplied) disables either limit.</summary>
  public const int DefaultGlobalCooldownMs = 30_000;

  public const int DefaultUserCooldownMs = 60_000;

  /// <summary>A command word is one token: <c>!hype</c>, <c>/shoutout</c>. The prefix is added by <see cref="NormalizeCommand"/>.</summary>
  [GeneratedRegex("^[a-z0-9_-]{1,49}$")]
  private static partial Regex CommandBodyPattern();

  public static Result<NormalizedAutomationTrigger> Normalize(AutomationTriggerUpsert upsert)
  {
    if (upsert.Config is null)
    {
      return Result.Fail<NormalizedAutomationTrigger>("Unsupported trigger kind: unknown.");
    }

    var globalCooldownResult = NormalizeCooldown(upsert.GlobalCooldownMs, DefaultGlobalCooldownMs);
    if (globalCooldownResult.IsFailed)
    {
      return Result.Fail<NormalizedAutomationTrigger>(globalCooldownResult.Errors);
    }

    var userCooldownResult = NormalizeCooldown(upsert.UserCooldownMs, DefaultUserCooldownMs);
    if (userCooldownResult.IsFailed)
    {
      return Result.Fail<NormalizedAutomationTrigger>(userCooldownResult.Errors);
    }

    var configResult = NormalizeConfig(upsert.Config);
    return configResult.IsFailed
      ? Result.Fail<NormalizedAutomationTrigger>(configResult.Errors)
      : Result.Ok(new NormalizedAutomationTrigger(
          KindOf(configResult.Value),
          upsert.ActionId,
          upsert.ModuleId,
          upsert.Enabled,
          globalCooldownResult.Value,
          userCooldownResult.Value,
          configResult.Value));
  }

  /// <summary>The one place a <see cref="TriggerConfig"/>'s concrete type maps to its <see cref="AutomationTriggerKind"/>.</summary>
  public static AutomationTriggerKind KindOf(TriggerConfig config) => config switch
  {
    RewardTriggerConfig => AutomationTriggerKind.Reward,
    TwitchEventTriggerConfig => AutomationTriggerKind.TwitchEvent,
    ChatPhraseTriggerConfig => AutomationTriggerKind.ChatPhrase,
    ViewerCommandTriggerConfig => AutomationTriggerKind.ViewerCommand,
    DashboardSlashTriggerConfig => AutomationTriggerKind.DashboardSlash,
    ManualTriggerConfig => AutomationTriggerKind.Manual,
    ModuleActivateTriggerConfig => AutomationTriggerKind.ModuleActivate,
    ModuleDeactivateTriggerConfig => AutomationTriggerKind.ModuleDeactivate,
    _ => throw new NotSupportedException($"Unsupported trigger config: {config.GetType()}."),
  };

  private static Result<int> NormalizeCooldown(int? value, int fallback) => value switch
  {
    null => Result.Ok(fallback),
    < 0 => Result.Fail<int>("Cooldowns must be zero or a positive number of milliseconds."),
    _ => Result.Ok(Math.Min(value.Value, MaxCooldownMs)),
  };

  private static Result<TriggerConfig> NormalizeConfig(TriggerConfig config) => config switch
  {
    RewardTriggerConfig c => NormalizeReward(c),
    TwitchEventTriggerConfig c => NormalizeTwitchEvent(c),
    ChatPhraseTriggerConfig c => NormalizeChatPhrase(c),
    ViewerCommandTriggerConfig c => NormalizeViewerCommand(c),
    DashboardSlashTriggerConfig c => NormalizeDashboardSlash(c),
    ManualTriggerConfig c => NormalizeManual(c),
    ModuleActivateTriggerConfig => Result.Ok(config),
    ModuleDeactivateTriggerConfig => Result.Ok(config),
    _ => Result.Fail<TriggerConfig>("Unsupported trigger config."),
  };

  private static Result<TriggerConfig> NormalizeReward(RewardTriggerConfig config)
  {
    var rewardId = (config.RewardId ?? string.Empty).Trim();
    return rewardId.Length switch
    {
      0 => Result.Fail<TriggerConfig>("A reward trigger needs a reward id."),
      > MaxRewardIdLength => Result.Fail<TriggerConfig>($"A reward trigger needs a reward id — {MaxRewardIdLength} characters or fewer."),
      _ => Result.Ok<TriggerConfig>(config with { RewardId = rewardId }),
    };
  }

  /// <summary>
  /// <see cref="Enum.IsDefined(Enum)"/> guards a caller constructing an out-of-range cast value
  /// directly (e.g. tests) — an unrecognized JSON string for <see cref="TwitchEventTriggerConfig.EventKind"/>
  /// fails ASP.NET model binding (400) before this method ever runs, same reasoning as
  /// <c>Narya.Core.Actions.ActionValidation</c>'s "Enum defaulting note".
  /// </summary>
  private static Result<TriggerConfig> NormalizeTwitchEvent(TwitchEventTriggerConfig config) =>
    Enum.IsDefined(config.EventKind)
      ? Result.Ok<TriggerConfig>(config)
      : Result.Fail<TriggerConfig>($"Unsupported Twitch event kind: {config.EventKind}.");

  private static Result<TriggerConfig> NormalizeChatPhrase(ChatPhraseTriggerConfig config)
  {
    var phrase = (config.Phrase ?? string.Empty).Trim();
    if (phrase.Length == 0)
    {
      return Result.Fail<TriggerConfig>("A chat phrase trigger needs a phrase.");
    }

    if (phrase.Length > MaxPhraseLength)
    {
      return Result.Fail<TriggerConfig>($"A chat phrase trigger needs a phrase — {MaxPhraseLength} characters or fewer.");
    }

    if (!Enum.IsDefined(config.Match))
    {
      return Result.Fail<TriggerConfig>($"Unsupported phrase match mode: {config.Match}.");
    }

    var rolesResult = NormalizeRoles(config.Roles);
    return rolesResult.IsFailed
      ? Result.Fail<TriggerConfig>(rolesResult.Errors)
      : Result.Ok<TriggerConfig>(config with { Phrase = phrase, Roles = rolesResult.Value });
  }

  private static Result<TriggerConfig> NormalizeViewerCommand(ViewerCommandTriggerConfig config)
  {
    var commandResult = NormalizeCommand(config.Command, '!');
    if (commandResult.IsFailed)
    {
      return Result.Fail<TriggerConfig>(commandResult.Errors);
    }

    var aliasesResult = NormalizeAliases(config.Aliases, '!', commandResult.Value);
    if (aliasesResult.IsFailed)
    {
      return Result.Fail<TriggerConfig>(aliasesResult.Errors);
    }

    var rolesResult = NormalizeRoles(config.Roles);
    return rolesResult.IsFailed
      ? Result.Fail<TriggerConfig>(rolesResult.Errors)
      : Result.Ok<TriggerConfig>(config with
      {
        Command = commandResult.Value,
        Aliases = aliasesResult.Value,
        Roles = rolesResult.Value,
      });
  }

  private static Result<TriggerConfig> NormalizeDashboardSlash(DashboardSlashTriggerConfig config)
  {
    var commandResult = NormalizeCommand(config.Command, '/');
    if (commandResult.IsFailed)
    {
      return Result.Fail<TriggerConfig>(commandResult.Errors);
    }

    var aliasesResult = NormalizeAliases(config.Aliases, '/', commandResult.Value);
    return aliasesResult.IsFailed
      ? Result.Fail<TriggerConfig>(aliasesResult.Errors)
      : Result.Ok<TriggerConfig>(config with { Command = commandResult.Value, Aliases = aliasesResult.Value });
  }

  private static Result<TriggerConfig> NormalizeManual(ManualTriggerConfig config)
  {
    var label = (config.Label ?? string.Empty).Trim();
    return label.Length switch
    {
      0 => Result.Fail<TriggerConfig>("A manual trigger needs a label."),
      > MaxLabelLength => Result.Fail<TriggerConfig>($"A manual trigger needs a label — {MaxLabelLength} characters or fewer."),
      _ => Result.Ok<TriggerConfig>(config with { Label = label }),
    };
  }

  /// <summary>Accepts <c>hype</c>, <c>!hype</c>, or <c>!HYPE</c> and always returns <c>!hype</c>.</summary>
  private static Result<string> NormalizeCommand(string? value, char prefix)
  {
    var raw = (value ?? string.Empty).Trim().ToLowerInvariant();
    var body = raw.Length > 0 && raw[0] == prefix ? raw[1..] : raw;
    return CommandBodyPattern().IsMatch(body)
      ? Result.Ok($"{prefix}{body}")
      : Result.Fail<string>($"Commands must start with {prefix} and use only letters, numbers, underscores, or hyphens.");
  }

  private static Result<IReadOnlyList<string>> NormalizeAliases(IReadOnlyList<string>? value, char prefix, string command)
  {
    var list = value ?? [];
    if (list.Count > MaxAliases)
    {
      return Result.Fail<IReadOnlyList<string>>($"A command can have at most {MaxAliases} aliases.");
    }

    var aliases = new List<string>();
    foreach (var entry in list)
    {
      var normalized = NormalizeCommand(entry, prefix);
      if (normalized.IsFailed)
      {
        return Result.Fail<IReadOnlyList<string>>(normalized.Errors);
      }

      if (normalized.Value != command && !aliases.Contains(normalized.Value))
      {
        aliases.Add(normalized.Value);
      }
    }

    return Result.Ok<IReadOnlyList<string>>(aliases);
  }

  /// <summary>Empty means "all viewers". Deduped, order preserved. See <see cref="NormalizeTwitchEvent"/>'s doc comment on <see cref="Enum.IsDefined(Enum)"/>'s role here.</summary>
  private static Result<IReadOnlyList<TriggerRole>> NormalizeRoles(IReadOnlyList<TriggerRole>? value)
  {
    var list = value ?? [];
    var roles = new List<TriggerRole>();
    foreach (var role in list)
    {
      if (!Enum.IsDefined(role))
      {
        return Result.Fail<IReadOnlyList<TriggerRole>>($"Unsupported trigger role: {role}.");
      }

      if (!roles.Contains(role))
      {
        roles.Add(role);
      }
    }

    return Result.Ok<IReadOnlyList<TriggerRole>>(roles);
  }
}
