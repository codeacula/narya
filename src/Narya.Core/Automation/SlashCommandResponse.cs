using Narya.Core.Actions;

namespace Narya.Core.Automation;

/// <summary>
/// The <c>POST /api/automation/slash</c> request body — a port of legacy's <c>SlashCommandRequest</c>
/// (<c>legacy/src/shared/api.ts:905-908</c>). <see cref="Input"/> is the raw text INCLUDING the
/// leading slash, exactly as the operator typed it into the dashboard command bar.
/// </summary>
public sealed record SlashCommandRequest
{
  public string Input { get; init; } = string.Empty;
}

/// <summary>
/// The <c>POST /api/automation/slash</c> response body — a port of legacy's <c>SlashCommandResponse</c>
/// (<c>legacy/src/shared/api.ts:914-918</c>). <see cref="Ok"/> false with a human-readable
/// <see cref="Message"/> is the NORMAL outcome for an unknown command, a typo, or a cooldown — this
/// route always answers HTTP 200; see
/// <c>Narya.Application.Automation.ITriggerDispatcher.HandleSlashCommandAsync</c>'s doc comment for
/// why an unrecognized command is rejected here rather than ever reaching Twitch chat.
/// </summary>
public sealed record SlashCommandResponse(bool Ok, string Message, ActionRunResult? Run);
