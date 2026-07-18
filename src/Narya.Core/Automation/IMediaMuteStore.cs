namespace Narya.Core.Automation;

/// <summary>
/// The <c>media:mute</c> WebSocket payload and the GET/PUT <c>/api/automation/media-mute</c>
/// response body — a port of legacy's <c>MediaMuteState</c> (<c>legacy/src/shared/api.ts</c>).
/// </summary>
public sealed record MediaMuteState(bool Muted);

/// <summary>
/// The master "mute sound/video commands" switch — a port of legacy's <c>mediaMute.ts</c> store
/// half (the route half is <c>Narya.Api.Controllers.MediaMuteController</c>, the broadcast half is
/// <c>Narya.Application.Automation.SetMediaMuteCommandHandler</c>). A single row so it persists
/// across a restart — a mid-stream restart must not silently un-mute.
///
/// <para>
/// Implemented by <c>Narya.Database.Automation.MediaMuteStore</c>; registered
/// <c>AddSingleton&lt;IMediaMuteStore, MediaMuteStore&gt;</c> in
/// <c>Narya.Database.ServiceCollectionExtensions.AddNaryaDatabase</c> — same
/// reference-direction constraint as <c>Narya.Core.Media.IMediaAssetStore</c> (defined here, not
/// alongside its implementation, so a Narya.Core-only consumer — including
/// <c>Narya.Application.Automation.MediaMuteGate</c>, the adapter that wires this store into
/// <c>Narya.Application.Actions.IMediaMuteGate</c> for <c>ActionExecutor</c>'s quickDisable check —
/// never needs to reference Narya.Database).
/// </para>
///
/// <para>
/// Deliberately no <c>FluentResults.Result</c> wrapper: unlike
/// <see cref="Narya.Core.Media.IMediaAssetStore"/>'s Create/Update, there is no validation that can
/// fail here — a bool is always a valid mute state — so both members return their plain value.
/// </para>
/// </summary>
public interface IMediaMuteStore
{
  /// <summary>False when no row has ever been written (fresh install — never muted by default).</summary>
  Task<bool> GetMutedAsync(CancellationToken cancellationToken);

  /// <summary>Upserts the single row and returns the resulting state.</summary>
  Task<MediaMuteState> SetMutedAsync(bool muted, CancellationToken cancellationToken);
}
