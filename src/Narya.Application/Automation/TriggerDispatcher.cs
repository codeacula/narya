using Microsoft.Extensions.Logging;

using Narya.Application.Actions;
using Narya.Core.Actions;
using Narya.Core.Automation;
using Narya.Core.Chat;
using Narya.Twitch;
using Narya.Twitch.Chat;
using Narya.Twitch.Helix;

namespace Narya.Application.Automation;

/// <summary>
/// <see cref="ITriggerDispatcher"/>'s implementation — see that interface's doc comment for the
/// architectural summary. Registered as a singleton (mirrors
/// <c>Narya.Application.Actions.ActionExecutor</c>), so <see cref="_cachedBotLogin"/> below caches
/// across every chat message for the process lifetime, the identical rationale and pattern as
/// <c>Narya.Twitch.EventSub.TwitchEventSubService._cachedBotLogin</c> (a separate cache: this
/// dispatcher and that EventSub service are two different singletons, each needing the bot's login
/// for their own independent bot-loop guard).
/// </summary>
public sealed partial class TriggerDispatcher(
  IAutomationTriggerStore triggerStore,
  IAutomationRunStore runStore,
  IActionExecutor executor,
  IHelixClient helixClient,
  IActiveModuleProvider activeModuleProvider,
  TimeProvider timeProvider,
  ILogger<TriggerDispatcher> logger) : ITriggerDispatcher
{
  private const int MaxDetailLength = 500;

  /// <summary>Resolved once via Helix and cached for the process lifetime — see this type's doc comment. A failed resolution is NOT cached, mirroring <c>TwitchEventSubService</c>.</summary>
  private string? _cachedBotLogin;

  public async Task<TriggerRunSummary?> InvokeAsync(
    AutomationTrigger trigger, TemplateContext context, TriggerInvokeOptions? options, CancellationToken cancellationToken)
  {
    var opts = options ?? new TriggerInvokeOptions();
    var at = timeProvider.GetUtcNow();

    if (opts.EnforceGates && !IsArmed(trigger))
    {
      return null;
    }

    if (opts.EnforceGates && await IsOnCooldownAsync(trigger, opts.ActorLogin, at, cancellationToken).ConfigureAwait(false))
    {
      return null;
    }

    var runId = Guid.NewGuid();
    var dedupeKey = string.IsNullOrEmpty(opts.EventId) ? null : $"{trigger.Id}:{opts.EventId}";
    var claimed = await runStore.TryClaimAsync(runId, trigger.Id, dedupeKey, opts.ActorLogin, at, cancellationToken).ConfigureAwait(false);
    if (!claimed)
    {
      return null;
    }

    ActionRunResult result;
    try
    {
      result = await executor.RunActionAsync(trigger.ActionId, context, cancellationToken).ConfigureAwait(false);
    }
    catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
    {
      throw;
    }
    catch (Exception ex)
    {
      // Deliberate blanket catch (documented exception #2 — see the Phase 4 plan's Global
      // Constraints; #1 is ActionExecutor.RunStepAsync's per-step catch): a trigger firing from a
      // live Twitch/chat event must never crash the caller over one Action's failure, and the
      // provisional run row must be finished with the truth rather than left stuck at "did not
      // complete."
      LogTriggerFailed(logger, trigger.Id, ex);
      var detail = Truncate(ErrorText(ex));
      await runStore.FinishAsync(runId, ActionRunStatus.Failed, detail, cancellationToken).ConfigureAwait(false);
      var failedResult = new ActionRunResult(trigger.ActionId, ActionRunStatus.Failed, [], at);
      return new TriggerRunSummary(trigger.Id, trigger.ActionId, failedResult);
    }

    await runStore.FinishAsync(runId, result.Status, DetailOf(result), cancellationToken).ConfigureAwait(false);
    return new TriggerRunSummary(trigger.Id, trigger.ActionId, result);
  }

  public async Task<IReadOnlyList<TriggerRunSummary>> HandleChatMessageAsync(ChatMessage message, CancellationToken cancellationToken)
  {
    // Bot-loop guard FIRST: without this, a send_chat step whose own text matches a phrase trigger
    // would re-trigger itself forever.
    var botLogin = (await GetBotLoginAsync(cancellationToken).ConfigureAwait(false))?.Trim().ToLowerInvariant() ?? string.Empty;
    var login = (message.Username ?? string.Empty).Trim().ToLowerInvariant();
    if (botLogin.Length > 0 && string.Equals(login, botLogin, StringComparison.Ordinal))
    {
      return [];
    }

    var text = message.Message ?? string.Empty;
    var actor = string.IsNullOrEmpty(message.DisplayName) ? message.Username : message.DisplayName;
    var tokens = Tokenize(text);
    var word = tokens.Length > 0 ? tokens[0] : string.Empty;

    var candidates = new List<(AutomationTrigger Trigger, TemplateContext Context)>();

    // Every matching phrase trigger fires — one message legitimately drives several Actions (a
    // sound, a banner, a chat reply), and cooldowns are the throttle, not first-match-wins.
    foreach (var trigger in await triggerStore.GetEnabledByKindAsync(AutomationTriggerKind.ChatPhrase, cancellationToken).ConfigureAwait(false))
    {
      if (trigger.Config is not ChatPhraseTriggerConfig config || !PassesRoleFilter(config.Roles, message.Badges))
      {
        continue;
      }

      var (hit, remainder) = PhraseMatch(config, text);
      if (!hit)
      {
        continue;
      }

      candidates.Add((trigger, new TemplateContext { Actor = actor, Login = login, Message = text, Input = remainder, Args = Tokenize(remainder) }));
    }

    if (word.Length > 0)
    {
      foreach (var trigger in await triggerStore.GetEnabledByKindAsync(AutomationTriggerKind.ViewerCommand, cancellationToken).ConfigureAwait(false))
      {
        if (trigger.Config is not ViewerCommandTriggerConfig config || !CommandMatch(config, word) || !PassesRoleFilter(config.Roles, message.Badges))
        {
          continue;
        }

        var input = text.Trim()[word.Length..].Trim();
        candidates.Add((trigger, new TemplateContext { Actor = actor, Login = login, Message = text, Input = input, Args = Tokenize(input) }));
      }
    }

    var options = new TriggerInvokeOptions
    {
      EventId = string.IsNullOrEmpty(message.Id) ? null : message.Id,
      ActorLogin = login.Length > 0 ? login : null,
    };
    return await InvokeAllAsync(candidates, options, cancellationToken).ConfigureAwait(false);
  }

  public async Task<IReadOnlyList<TriggerRunSummary>> HandleTwitchEventAsync(TwitchEventSignalNotification signal, CancellationToken cancellationToken)
  {
    var login = signal.Login?.Trim().ToLowerInvariant() ?? string.Empty;
    var context = new TemplateContext
    {
      Actor = signal.Actor,
      Login = login,
      Amount = signal.Amount,
      Tier = signal.Tier,
      Months = signal.Months,
    };

    var candidates = new List<(AutomationTrigger Trigger, TemplateContext Context)>();
    foreach (var trigger in await triggerStore.GetEnabledByKindAsync(AutomationTriggerKind.TwitchEvent, cancellationToken).ConfigureAwait(false))
    {
      if (trigger.Config is TwitchEventTriggerConfig config && config.EventKind == signal.Kind)
      {
        candidates.Add((trigger, context));
      }
    }

    var options = new TriggerInvokeOptions { EventId = signal.EventId, ActorLogin = login.Length > 0 ? login : null };
    return await InvokeAllAsync(candidates, options, cancellationToken).ConfigureAwait(false);
  }

  public async Task<IReadOnlyList<TriggerRunSummary>> HandleRewardRedemptionAsync(RewardRedeemedSignalNotification signal, CancellationToken cancellationToken)
  {
    var login = signal.Login?.Trim().ToLowerInvariant() ?? string.Empty;
    var input = signal.UserInput?.Trim() ?? string.Empty;
    var context = new TemplateContext
    {
      Actor = signal.Actor,
      Login = login,
      RewardTitle = signal.RewardTitle,
      Input = input,
      Args = Tokenize(input),
    };

    var candidates = new List<(AutomationTrigger Trigger, TemplateContext Context)>();
    foreach (var trigger in await triggerStore.GetEnabledByKindAsync(AutomationTriggerKind.Reward, cancellationToken).ConfigureAwait(false))
    {
      if (trigger.Config is RewardTriggerConfig config && config.RewardId == signal.RewardId)
      {
        candidates.Add((trigger, context));
      }
    }

    var options = new TriggerInvokeOptions { EventId = signal.EventId, ActorLogin = login.Length > 0 ? login : null };
    return await InvokeAllAsync(candidates, options, cancellationToken).ConfigureAwait(false);
  }

  public async Task<IReadOnlyList<TriggerRunSummary>> HandleModuleLifecycleAsync(
    ModuleLifecyclePhase phase, Guid moduleId, string? moduleName, CancellationToken cancellationToken)
  {
    var kind = phase == ModuleLifecyclePhase.Activate ? AutomationTriggerKind.ModuleActivate : AutomationTriggerKind.ModuleDeactivate;
    var context = string.IsNullOrEmpty(moduleName) ? new TemplateContext() : new TemplateContext { Module = moduleName };

    // A lifecycle trigger is scoped by its OWN ModuleId (null = every module), not by what is
    // live: a deactivate trigger must still fire once its module has gone away.
    var candidates = new List<(AutomationTrigger Trigger, TemplateContext Context)>();
    foreach (var trigger in await triggerStore.GetEnabledByKindAsync(kind, cancellationToken).ConfigureAwait(false))
    {
      if (trigger.ModuleId is null || trigger.ModuleId == moduleId)
      {
        candidates.Add((trigger, context));
      }
    }

    return await InvokeAllAsync(candidates, new TriggerInvokeOptions { EnforceGates = false }, cancellationToken).ConfigureAwait(false);
  }

  public async Task<ActionRunResult?> RunTriggerManuallyAsync(Guid triggerId, TemplateContext context, CancellationToken cancellationToken)
  {
    var trigger = await triggerStore.GetByIdAsync(triggerId, cancellationToken).ConfigureAwait(false);
    if (trigger is null)
    {
      return null;
    }

    var actorLogin = context.Login?.Trim().ToLowerInvariant();
    var options = new TriggerInvokeOptions { ActorLogin = string.IsNullOrEmpty(actorLogin) ? null : actorLogin, EnforceGates = false };
    var summary = await InvokeAsync(trigger, context, options, cancellationToken).ConfigureAwait(false);

    // EnforceGates:false + a null-event-id dedupe key (no EventId supplied above) can never
    // collide with anything, so InvokeAsync only returns null here if TryClaimAsync itself failed
    // unexpectedly — not a normal outcome for a manual run. Surfacing that as a thrown exception
    // (rather than a silent null the controller would otherwise read as "trigger not found") keeps
    // RunTriggerManuallyAsync's null strictly meaning "no such trigger."
    return summary?.Result ?? throw new InvalidOperationException($"Trigger {triggerId} did not run.");
  }

  /// <summary>
  /// A dashboard slash command never leaves the machine: it resolves to a local trigger or is
  /// rejected here. An unknown <c>/command</c> is answered with <c>Ok: false</c> so an operator's
  /// typo can never be forwarded to Twitch chat as a public message.
  ///
  /// <para>
  /// Context convention (deliberate, and different from a viewer <c>!command</c>): a private
  /// operator command is always <c>/command &lt;target&gt; &lt;free text&gt;</c>, so
  /// <c>{login}</c>/<c>{actor}</c> are the TARGET and <c>{args}</c> is the free text after it.
  /// <c>{input}</c> still holds everything after the command word, which a targetless command
  /// should use instead.
  /// </para>
  /// </summary>
  public async Task<SlashCommandResponse> HandleSlashCommandAsync(string? input, CancellationToken cancellationToken)
  {
    var text = (input ?? string.Empty).Trim();
    if (!text.StartsWith('/'))
    {
      return new SlashCommandResponse(false, "Slash commands must start with /.", null);
    }

    var tokens = Tokenize(text);
    var word = (tokens.Length > 0 ? tokens[0] : string.Empty).ToLowerInvariant();
    if (word == "/" || word.Length < 2)
    {
      return new SlashCommandResponse(false, "Type a command after the slash.", null);
    }

    AutomationTrigger? trigger = null;
    foreach (var candidate in await triggerStore.GetEnabledByKindAsync(AutomationTriggerKind.DashboardSlash, cancellationToken).ConfigureAwait(false))
    {
      if (candidate.Config is DashboardSlashTriggerConfig config && (config.Command == word || config.Aliases.Contains(word)))
      {
        trigger = candidate;
        break;
      }
    }

    if (trigger is null)
    {
      return new SlashCommandResponse(false, $"Unknown command {word}.", null);
    }

    if (!IsArmed(trigger))
    {
      return new SlashCommandResponse(false, $"{word} belongs to a module that is not active.", null);
    }

    var args = tokens.Skip(1).Select(StripAt).ToList();
    var target = args.Count > 0 ? args[0] : string.Empty;
    var targetLogin = target.ToLowerInvariant();
    var context = new TemplateContext
    {
      Actor = target,
      Login = targetLogin,
      Message = text,
      Input = text[word.Length..].Trim(),
      Args = args,
    };

    var options = new TriggerInvokeOptions { ActorLogin = targetLogin.Length > 0 ? targetLogin : null };
    var summary = await InvokeAsync(trigger, context, options, cancellationToken).ConfigureAwait(false);
    if (summary is null)
    {
      return new SlashCommandResponse(false, $"{word} is cooling down.", null);
    }

    var status = summary.Result.Status;
    var ok = status is ActionRunStatus.Succeeded or ActionRunStatus.Partial;
    var message = SlashResultMessage(word, ok, status, summary.Result);

    return new SlashCommandResponse(ok, message, summary.Result);
  }

  /// <summary>A skipped run means every step rendered empty — almost always a missing argument.</summary>
  private static string SlashResultMessage(string word, bool ok, ActionRunStatus status, ActionRunResult result) => ok switch
  {
    true => $"{word} ran.",
    false when status == ActionRunStatus.Skipped => $"{word} did nothing — check the command's arguments.",
    false => $"{word} failed. {DetailOf(result)}".Trim(),
  };

  /// <summary>A trigger with a null <see cref="AutomationTrigger.ModuleId"/> is global; a non-null one is armed only while that module is the live one.</summary>
  private bool IsArmed(AutomationTrigger trigger) => trigger.ModuleId is null || trigger.ModuleId == activeModuleProvider.GetActiveModuleId();

  private async Task<bool> IsOnCooldownAsync(AutomationTrigger trigger, string? actorLogin, DateTimeOffset at, CancellationToken cancellationToken)
  {
    if (trigger.GlobalCooldownMs > 0)
    {
      var last = await runStore.GetLastRunAtAsync(trigger.Id, cancellationToken).ConfigureAwait(false);
      if (last is { } lastRunAt && (at - lastRunAt).TotalMilliseconds < trigger.GlobalCooldownMs)
      {
        return true;
      }
    }

    if (trigger.UserCooldownMs > 0 && !string.IsNullOrEmpty(actorLogin))
    {
      var last = await runStore.GetLastUserRunAtAsync(trigger.Id, actorLogin, cancellationToken).ConfigureAwait(false);
      if (last is { } lastRunAt && (at - lastRunAt).TotalMilliseconds < trigger.UserCooldownMs)
      {
        return true;
      }
    }

    return false;
  }

  private async Task<IReadOnlyList<TriggerRunSummary>> InvokeAllAsync(
    IReadOnlyList<(AutomationTrigger Trigger, TemplateContext Context)> candidates, TriggerInvokeOptions options, CancellationToken cancellationToken)
  {
    var summaries = new List<TriggerRunSummary>();
    foreach (var (trigger, context) in candidates)
    {
      var summary = await InvokeAsync(trigger, context, options, cancellationToken).ConfigureAwait(false);
      if (summary is not null)
      {
        summaries.Add(summary);
      }
    }

    return summaries;
  }

  /// <summary>Resolves the bot account's login once via Helix and caches it for the process lifetime — a failed resolution is NOT cached, so a bot configured later is picked up on the next chat message.</summary>
  private async Task<string?> GetBotLoginAsync(CancellationToken cancellationToken)
  {
    if (!string.IsNullOrEmpty(_cachedBotLogin))
    {
      return _cachedBotLogin;
    }

    var result = await helixClient.GetAuthenticatedUserAsync(TwitchProvider.Bot, cancellationToken).ConfigureAwait(false);
    if (result.IsFailed)
    {
      return null;
    }

    _cachedBotLogin = result.Value.Login.ToLowerInvariant();
    return _cachedBotLogin;
  }

  private static bool PassesRoleFilter(IReadOnlyList<TriggerRole> allowed, IReadOnlyDictionary<string, string>? badges)
  {
    // Everyone is a viewer, so a `viewer` allowlist admits the whole channel.
    if (allowed.Count == 0 || allowed.Contains(TriggerRole.Viewer))
    {
      return true;
    }

    var roles = ChatRoleResolver.ResolveAllRoles(badges);
    return roles.Any(role => allowed.Contains(ToTriggerRole(role)));
  }

  private static TriggerRole ToTriggerRole(ChatRole role) => role switch
  {
    ChatRole.Broadcaster => TriggerRole.Broadcaster,
    ChatRole.Moderator => TriggerRole.Mod,
    ChatRole.Vip => TriggerRole.Vip,
    ChatRole.Subscriber => TriggerRole.Sub,
    _ => TriggerRole.Viewer,
  };

  private static (bool Hit, string Remainder) PhraseMatch(ChatPhraseTriggerConfig config, string message)
  {
    var text = message.Trim();
    var haystack = text.ToLowerInvariant();
    var needle = config.Phrase.Trim().ToLowerInvariant();
    if (needle.Length == 0)
    {
      return (false, string.Empty);
    }

    return config.Match switch
    {
      ChatPhraseMatch.Exact => (haystack == needle, string.Empty),
      ChatPhraseMatch.StartsWith => haystack.StartsWith(needle, StringComparison.Ordinal)
        ? (true, text[needle.Length..].Trim())
        : (false, string.Empty),
      ChatPhraseMatch.Contains => (haystack.Contains(needle, StringComparison.Ordinal), text),
      _ => (false, string.Empty),
    };
  }

  private static bool CommandMatch(ViewerCommandTriggerConfig config, string word)
  {
    var candidate = word.ToLowerInvariant();
    return candidate == config.Command || config.Aliases.Contains(candidate);
  }

  private static string[] Tokenize(string text) => text.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);

  /// <summary>Logins are typed with an @ as often as not.</summary>
  private static string StripAt(string value) => value.TrimStart('@');

  private static string DetailOf(ActionRunResult result)
  {
    var problems = string.Join("; ", result.Steps.Where(s => s.Status != ActionStepStatus.Succeeded && s.Detail.Length > 0).Select(s => s.Detail));
    return Truncate(problems);
  }

  private static string Truncate(string value) => value.Length > MaxDetailLength ? value[..MaxDetailLength] : value;

  private static string ErrorText(Exception exception) => string.IsNullOrEmpty(exception.Message) ? exception.GetType().Name : exception.Message;

  [LoggerMessage(Level = LogLevel.Error, Message = "Automation: trigger {TriggerId} failed")]
  private static partial void LogTriggerFailed(ILogger logger, Guid triggerId, Exception exception);
}
