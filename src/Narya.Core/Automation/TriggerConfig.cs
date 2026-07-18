using System.Text.Json.Serialization;

namespace Narya.Core.Automation;

/// <summary>Twitch alert kinds a <see cref="TwitchEventTriggerConfig"/> can bind to — a port of legacy's <c>AlertEventKind</c>.</summary>
public enum TwitchAlertEventKind
{
  Sub = 0,
  Gift = 1,
  Cheer = 2,
  Raid = 3,
  Follow = 4,
}

/// <summary>How a <see cref="ChatPhraseTriggerConfig"/> compares an incoming chat message to its phrase.</summary>
public enum ChatPhraseMatch
{
  Exact = 0,
  Contains = 1,
  StartsWith = 2,
}

/// <summary>
/// Twitch roles that may fire a <see cref="ChatPhraseTriggerConfig"/> or
/// <see cref="ViewerCommandTriggerConfig"/> — a port of legacy's <c>TriggerRole</c>. An empty
/// <c>Roles</c> list means "everyone", not "no one" — see
/// <c>Narya.Core.Automation.AutomationTriggerValidation.NormalizeRoles</c>.
/// </summary>
public enum TriggerRole
{
  Broadcaster = 0,
  Mod = 1,
  Vip = 2,
  Sub = 3,
  Viewer = 4,
}

/// <summary>
/// The kind-specific configuration of an <see cref="AutomationTrigger"/> — a port of legacy's
/// per-kind <c>*TriggerConfig</c> union (<c>legacy/src/shared/api.ts:868-902</c>). Each concrete
/// subtype IS its trigger's kind (see <see cref="AutomationTriggerValidation.KindOf"/>): there is
/// no separate enum a caller could set inconsistently with the config it attached, the same
/// invalid-state-unrepresentable reasoning as <c>Narya.Core.Actions.ActionStep</c>'s doc comment.
/// <see cref="AutomationTrigger.Kind"/> still exists as its own stored/wire field (the plan calls
/// for it, and <c>Narya.Database.NaryaMartenConfig</c> indexes it directly rather than making every
/// dispatcher/listing query branch on <c>Config</c>'s runtime type) — but it is always DERIVED from
/// the config's concrete type by <see cref="AutomationTriggerValidation.Normalize"/>, never
/// independently supplied by a caller, so the two can never disagree.
///
/// <para>
/// <b>JSON shape:</b> the same hand-written discriminated-union approach as <c>ActionStep</c>/
/// <c>ActionStepJsonConverter</c>, for the identical reason — Marten's <c>SystemTextJsonSerializer</c>
/// does not preserve "discriminator property first" ordering on write, which the BCL's
/// <c>[JsonPolymorphic]</c>/<c>[JsonDerivedType]</c> attributes require on read. See
/// <see cref="TriggerConfigJsonConverter"/>. The discriminator values are legacy's own snake_case
/// kind literals ("twitch_event", "chat_phrase", …) — NOT the camelCase
/// <see cref="AutomationTriggerKind"/> enum member names emitted for <see cref="AutomationTrigger.Kind"/>
/// itself by the API's global <c>JsonStringEnumConverter(JsonNamingPolicy.CamelCase)</c>
/// (<c>Narya.Api.Program.cs</c>) — the two fields intentionally use different casing conventions:
/// <c>Config</c>'s discriminator is a converter-owned literal exactly like <c>ActionStep.type</c>,
/// while <c>Kind</c> is a genuine C# enum bound by the same global policy every other enum in this
/// API uses.
/// </para>
/// </summary>
[JsonConverter(typeof(TriggerConfigJsonConverter))]
public abstract record TriggerConfig;

public sealed record RewardTriggerConfig : TriggerConfig
{
  public string RewardId { get; init; } = string.Empty;
}

public sealed record TwitchEventTriggerConfig : TriggerConfig
{
  /// <summary>
  /// Nullable — unlike <c>Narya.Core.Actions.ActionValidation</c>'s "Enum defaulting note" cases,
  /// an omitted <c>eventKind</c> must not silently bind to <see cref="TwitchAlertEventKind.Sub"/>
  /// (the zero member): a missing value here is a routing footgun, not an acceptable default. See
  /// <see cref="AutomationTriggerValidation.NormalizeTwitchEvent"/>, which fails a <see langword="null"/>
  /// value explicitly.
  /// </summary>
  public TwitchAlertEventKind? EventKind { get; init; }
}

/// <summary><see cref="Roles"/> empty means "all viewers" — see <see cref="AutomationTriggerValidation"/>.</summary>
public sealed record ChatPhraseTriggerConfig : TriggerConfig
{
  public string Phrase { get; init; } = string.Empty;

  /// <summary>Nullable for the same reason as <see cref="TwitchEventTriggerConfig.EventKind"/> — see its doc comment.</summary>
  public ChatPhraseMatch? Match { get; init; }

  public IReadOnlyList<TriggerRole> Roles { get; init; } = [];
}

/// <summary>A public <c>!command</c> typed by a viewer in chat.</summary>
public sealed record ViewerCommandTriggerConfig : TriggerConfig
{
  public string Command { get; init; } = string.Empty;

  public IReadOnlyList<string> Aliases { get; init; } = [];

  public IReadOnlyList<TriggerRole> Roles { get; init; } = [];
}

/// <summary>A private <c>/command</c> typed by the operator in the dashboard. Never sent to Twitch.</summary>
public sealed record DashboardSlashTriggerConfig : TriggerConfig
{
  public string Command { get; init; } = string.Empty;

  public IReadOnlyList<string> Aliases { get; init; } = [];
}

public sealed record ManualTriggerConfig : TriggerConfig
{
  public string Label { get; init; } = string.Empty;
}

/// <summary>
/// Fires when a category module (Phase 8) becomes the active module. No fields — legacy's
/// <c>ModuleLifecycleTriggerConfig</c> is <c>Record&lt;string, never&gt;</c>.
/// </summary>
public sealed record ModuleActivateTriggerConfig : TriggerConfig;

/// <summary>Fires when a category module (Phase 8) stops being the active module. No fields.</summary>
public sealed record ModuleDeactivateTriggerConfig : TriggerConfig;
