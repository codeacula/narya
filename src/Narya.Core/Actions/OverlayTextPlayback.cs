namespace Narya.Core.Actions;

/// <summary>
/// The <c>overlay:text</c> broadcast payload consumed by the <c>/overlay/text</c> browser source —
/// a port of legacy's <c>OverlayTextPlayback</c> (<c>legacy/src/shared/api.ts:847-854</c>). Emitted
/// exclusively by <c>Narya.Application.Actions.ActionExecutor</c> dispatching a
/// <see cref="ShowTextActionStep"/> — this is the RESOLVED playback only (the rendered text, never
/// the raw template), so the overlay — a public, unauthenticated browser source — never sees the
/// operator's Action configuration. <c>Tone</c> is an optional accent colour hint (mirrors legacy's
/// <c>StreamEvent.tone</c>: warning/info/note/silver); absent means the overlay uses its default
/// accent.
/// </summary>
public sealed record OverlayTextPlayback(Guid Id, string Text, int DurationMs, TextStyle Style, string? Tone);
