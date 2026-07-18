using System.Text.Json.Serialization;

namespace Narya.Core.Actions;

/// <summary>How a multi-asset <c>play_media</c> step picks which asset to play.</summary>
public enum MediaSelection
{
  First = 0,
  Random = 1,
}

/// <summary>Presentation of an overlay text banner.</summary>
public enum TextStyle
{
  Banner = 0,
  Toast = 1,
  Centered = 2,
}

/// <summary>Who a <c>send_chat</c> step's message is posted as.</summary>
public enum ChatSender
{
  User = 0,
  Bot = 1,
}

/// <summary>
/// A single step of an <see cref="AutomationAction"/> — a port of legacy's discriminated-union
/// <c>ActionStep</c> (<c>legacy/src/shared/api.ts:708-772</c>). <c>delayMs</c> is relative to the
/// start of the invocation, not to the previous step: due steps start in stored order WITHOUT
/// waiting for media playback to finish, so text, video, and TTS can land together (Phase 4 Task
/// 3's executor). A step that fails does not abort the ones after it.
///
/// <para>
/// <b>Modeling choice:</b> each step type is its own sealed record deriving from this abstract
/// base, discriminated on the wire by a <c>"type"</c> string property — every subtype is a genuine
/// C# type, so a step's fields for its OWN type are non-nullable and there is no way to construct
/// a "show_text step with a play_media payload" invalid state; the compiler enforces exhaustiveness
/// in <c>Narya.Core.Actions.ActionValidation</c>'s per-type switch. Fields serialize FLAT
/// (<c>{ "type": "show_text", "template": "...", ... }</c>) rather than nested under a
/// <c>payload</c> key like legacy — reasonable since Phase 6+ writes a fresh Vue client against
/// this contract rather than the legacy TS one.
/// </para>
///
/// <para>
/// <b>Why a hand-written <see cref="ActionStepJsonConverter"/> instead of the BCL's
/// <see cref="JsonPolymorphicAttribute"/>/<see cref="JsonDerivedTypeAttribute"/>:</b> that was the
/// first attempt, and it round-trips fine through a bare <c>JsonSerializer.Serialize/Deserialize</c>
/// call — but it does NOT round-trip through <c>Narya.Database.Actions.ActionStore</c> (discovered
/// via this project's Testcontainers-Postgres tests, not assumed). The BCL's polymorphic
/// deserializer requires the <c>"type"</c> discriminator to be the FIRST property it encounters in
/// the JSON object (a forward-only-reader constraint); Marten's own
/// <c>SystemTextJsonSerializer</c> does not preserve "discriminator first" property order when it
/// persists a <see cref="ActionDocument.Steps"/> element — the discriminator lands several
/// properties in, and every read then throws
/// <c>System.NotSupportedException: The JSON payload for polymorphic interface or abstract type
/// 'Narya.Core.Actions.ActionStep' must specify a type discriminator.</c> <see cref="ActionStepJsonConverter"/>
/// instead buffers each element via <see cref="System.Text.Json.JsonDocument.ParseValue"/> before
/// picking a concrete type, so property order never matters on read; see its own doc comment.
/// </para>
///
/// <para>
/// <b>Same type reused for both read (API responses, Marten storage) and write (POST/PUT
/// bodies):</b> legacy's <c>ActionStepInput</c> is a <c>DistributiveOmit&lt;ActionStep, 'id' |
/// 'position'&gt;</c> because the server always assigns both on save. Here, System.Text.Json
/// silently ignores an <c>id</c>/<c>position</c> the client sends (or leaves them at their
/// zero-value defaults if absent), and <c>Narya.Database.Actions.ActionStore</c> always
/// OVERWRITES both on every Create/Update (see its <c>AssignStepIdentity</c>) — so a distinct
/// input type would add ceremony without changing behavior. This also means <see cref="Id"/> is
/// NOT stable across saves: every save re-assigns a fresh id to every step, matching legacy's
/// delete-all-reinsert <c>saveSteps</c> exactly.
/// </para>
///
/// <para>
/// <b>Reused directly as the Marten embedded-storage element</b> (see
/// <c>Narya.Database.Actions.ActionDocument.Steps</c>) rather than a separate storage-only DTO —
/// see <c>ActionDocument</c>'s doc comment for why that duplication (which
/// <c>MediaAssetDocument</c> accepts for its 2-value enums) is not worth it for an 11-way union.
/// </para>
/// </summary>
[JsonConverter(typeof(ActionStepJsonConverter))]
public abstract record ActionStep
{
  /// <summary>Re-assigned by the store on every save — see this type's doc comment.</summary>
  public Guid Id { get; init; }

  /// <summary>Array index at save time — re-assigned by the store on every save.</summary>
  public int Position { get; init; }

  public bool Enabled { get; init; } = true;

  /// <summary>Relative to the start of the Action's invocation, not the previous step. 0..600000.</summary>
  public int DelayMs { get; init; }
}

/// <summary>
/// `tone` is an optional accent (mirrors legacy's StreamEvent.tone: warning/info/note/silver), so
/// a migrated sub alert keeps reading gold and a cheer blue. Absent = the default accent.
/// </summary>
public sealed record ShowTextActionStep : ActionStep
{
  public string Template { get; init; } = string.Empty;

  public int DurationMs { get; init; }

  public TextStyle Style { get; init; }

  public string? Tone { get; init; }
}

public sealed record PlayMediaActionStep : ActionStep
{
  public IReadOnlyList<Guid> AssetIds { get; init; } = [];

  public MediaSelection Selection { get; init; }

  /// <summary>
  /// Absent means "use the asset's own volume" — not the same as an explicit 0 — so this stays
  /// nullable rather than defaulting. See <c>Narya.Core.Actions.ActionValidation</c>.
  /// </summary>
  public double? Volume { get; init; }
}

public sealed record TtsSpeakActionStep : ActionStep
{
  public string Template { get; init; } = string.Empty;
}

public sealed record SendChatActionStep : ActionStep
{
  public string Template { get; init; } = string.Empty;

  public ChatSender Sender { get; init; }
}

public sealed record LlmResponseActionStep : ActionStep
{
  public string Template { get; init; } = string.Empty;
}

public sealed record ObsSceneActionStep : ActionStep
{
  public string SceneName { get; init; } = string.Empty;
}

public sealed record ObsTransitionActionStep : ActionStep;

public sealed record TwitchShoutoutActionStep : ActionStep
{
  public string LoginTemplate { get; init; } = string.Empty;
}

public sealed record TwitchWhisperActionStep : ActionStep
{
  public string LoginTemplate { get; init; } = string.Empty;

  public string Template { get; init; } = string.Empty;
}

/// <summary>
/// <c>secondsTemplate</c> is a template, not a number, so <c>/timeout bob 300 spam</c> can bind
/// the duration from the invocation (<c>"{arg2}"</c>) instead of being locked to whatever the
/// Action stored. A LITERAL value (no <c>{</c>) is range-checked at save time
/// (<c>Narya.Core.Actions.ActionValidation</c>); a templated one can only be range-checked at
/// render time (Phase 4 Task 3's executor), which falls back to
/// <see cref="ActionValidation.DefaultTimeoutSeconds"/> rather than failing the step.
/// </summary>
public sealed record TwitchTimeoutActionStep : ActionStep
{
  public string LoginTemplate { get; init; } = string.Empty;

  public string SecondsTemplate { get; init; } = string.Empty;

  public string ReasonTemplate { get; init; } = string.Empty;
}

public sealed record TwitchBanActionStep : ActionStep
{
  public string LoginTemplate { get; init; } = string.Empty;

  public string ReasonTemplate { get; init; } = string.Empty;
}
