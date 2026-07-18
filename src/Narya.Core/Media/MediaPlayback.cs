namespace Narya.Core.Media;

/// <summary>
/// The <c>media:play</c> broadcast payload — a port of legacy's <c>MediaPlayback</c>
/// (<c>RewardMedia &amp; {'{'} id, actor? {'}'}</c>, <c>legacy/src/shared/api.ts:380-383</c>).
/// Emitted exclusively by <c>Narya.Application.Actions.ActionExecutor</c> dispatching a
/// <c>PlayMediaActionStep</c>, after the step has resolved the asset through
/// <see cref="IMediaResolver"/> — THE single choke point (see that interface's doc comment) — so
/// this payload's <see cref="Kind"/>/<see cref="Src"/> always come from a live, enabled, available
/// <see cref="MediaAsset"/>, never straight from the step's configured asset ids. <c>Volume</c> is
/// the step's own volume override if set, otherwise the asset's configured volume. <c>Actor</c> is
/// the display name of whoever caused the invocation, when known.
/// </summary>
public sealed record MediaPlayback(Guid Id, MediaKind Kind, string Src, double Volume, string? Actor);
