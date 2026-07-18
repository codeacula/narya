using System.Globalization;
using System.Text.RegularExpressions;

namespace Narya.Application.Actions;

/// <summary>
/// Everything an Action template may interpolate — a port of legacy's <c>TemplateContext</c>
/// (<c>legacy/src/shared/api.ts:827-844</c>). Absent fields render as an empty string rather than
/// the literal token, so e.g. a follow alert reusing a template with <c>{months}</c> degrades
/// quietly instead of printing <c>{months}</c> — see <see cref="ActionTemplate.Render"/>.
/// </summary>
public sealed record TemplateContext
{
  public string? Actor { get; init; }
  public string? Login { get; init; }
  public string? Message { get; init; }
  public string? Input { get; init; }
  public IReadOnlyList<string> Args { get; init; } = [];
  public string? RewardTitle { get; init; }
  public int? Amount { get; init; }
  public string? Tier { get; init; }
  public int? Months { get; init; }
  public string? Category { get; init; }
  public string? Module { get; init; }
}

/// <summary>
/// Interpolates a <see cref="TemplateContext"/> into an Action template — a pure static port of
/// legacy's <c>renderActionTemplate</c> (<c>legacy/src/server/actionTemplates.ts</c>). No I/O, no
/// injected ports: every seam Phase 4 Task 3's executor needs (media resolution, Twitch calls,
/// delay/random) lives on <c>IActionStepPorts</c>/<c>ActionExecutor</c> instead, so this stays
/// trivially unit-testable and reusable from anywhere a template needs rendering (a future preview
/// endpoint, for instance).
///
/// <para>
/// <b>Known vs. unknown tokens:</b> a KNOWN token whose field is absent renders as an empty string,
/// never the literal token. An UNKNOWN token (a typo, or a token this renderer does not support) is
/// left intact — <c>{typo}</c> stays <c>{typo}</c> — so an operator's mistake stays visible in the
/// rendered output instead of silently vanishing.
/// </para>
///
/// <para>
/// <b>Single-pass, deliberately:</b> <see cref="Render"/> walks the ORIGINAL template exactly once.
/// An interpolated value that itself contains token-shaped text (e.g. a chat message of literal
/// text <c>{actor}</c> — chat is attacker-controlled) is never re-expanded. <see cref="Regex.Replace(string, MatchEvaluator)"/>
/// already has this property (it scans the input string once and never re-scans replacement text),
/// so no extra guard is needed here beyond not looping.
/// </para>
/// </summary>
public static partial class ActionTemplate
{
  // {arg1}, {arg2}… index into Args and are handled separately because their names are open-ended.
  [GeneratedRegex(@"\{([A-Za-z][A-Za-z0-9]*)\}")]
  private static partial Regex TokenPattern();

  [GeneratedRegex(@"^arg([1-9][0-9]*)$")]
  private static partial Regex ArgTokenPattern();

  // {rest} / {restN}: every argument AFTER position N, joined. {rest} is {rest1} — this is what
  // makes "target and remainder" commands expressible: `/whisper bob hi there` binds {arg1} as the
  // target and {rest1} as the message, where {args} would wrongly re-include the target.
  [GeneratedRegex(@"^rest([1-9][0-9]*)?$")]
  private static partial Regex RestTokenPattern();

  public static string Render(string? template, TemplateContext context) =>
    string.IsNullOrEmpty(template) ? string.Empty : TokenPattern().Replace(template, match => ReplaceToken(match, context));

  private static string ReplaceToken(Match match, TemplateContext context)
  {
    var token = match.Groups[1].Value;
    return IsKnownToken(token) ? ResolveToken(token, context) ?? string.Empty : match.Value;
  }

  /// <summary>
  /// The 11 tokens that resolve straight to a <see cref="TemplateContext"/> field — everything
  /// else (args/rest patterns) is dynamic, computed from <see cref="TemplateContext.Args"/> rather
  /// than read off a single property.
  /// </summary>
  private static readonly HashSet<string> StaticTokens = new(StringComparer.Ordinal)
  {
    "actor", "login", "message", "input", "args", "rewardTitle", "amount", "tier", "months", "category", "module",
  };

  /// <summary>
  /// "rest" (no digit) already matches <see cref="RestTokenPattern"/> (its numeric group is
  /// optional), so it needs no separate check here.
  /// </summary>
  private static bool IsKnownToken(string token) =>
    StaticTokens.Contains(token) || ArgTokenPattern().IsMatch(token) || RestTokenPattern().IsMatch(token);

  private static string? ResolveToken(string token, TemplateContext context) =>
    StaticTokens.Contains(token) ? ResolveStaticToken(token, context) : ResolveDynamicToken(token, context);

  private static string? ResolveStaticToken(string token, TemplateContext context) => token switch
  {
    "actor" => context.Actor,
    "login" => context.Login,
    "message" => context.Message,
    "input" => context.Input,
    "args" => string.Join(' ', context.Args),
    "rewardTitle" => context.RewardTitle,
    "amount" => context.Amount?.ToString(CultureInfo.InvariantCulture),
    "tier" => context.Tier,
    "months" => context.Months?.ToString(CultureInfo.InvariantCulture),
    "category" => context.Category,
    "module" => context.Module,
    // Unreachable: only called once StaticTokens.Contains(token) is true, and the 11 cases above
    // are exactly StaticTokens' members.
    _ => null,
  };

  private static string? ResolveDynamicToken(string token, TemplateContext context)
  {
    var argMatch = ArgTokenPattern().Match(token);
    if (argMatch.Success)
    {
      // Known-shaped but out of range still renders empty rather than the literal token.
      var index = int.Parse(argMatch.Groups[1].Value, CultureInfo.InvariantCulture) - 1;
      return index >= 0 && index < context.Args.Count ? context.Args[index] : string.Empty;
    }

    var restMatch = RestTokenPattern().Match(token);
    if (restMatch.Success)
    {
      var from = restMatch.Groups[1].Success
        ? int.Parse(restMatch.Groups[1].Value, CultureInfo.InvariantCulture)
        : 1;
      return string.Join(' ', context.Args.Skip(from));
    }

    // Unreachable: Render only calls ResolveToken once IsKnownToken(token) is true, and the arg
    // pattern + rest pattern checked above are exactly the non-static half of IsKnownToken's logic.
    return null;
  }
}
