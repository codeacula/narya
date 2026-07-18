using Narya.Application.Actions;
using Narya.Core.Automation;

namespace Narya.Application.Automation;

/// <summary>
/// The REAL <see cref="IMediaMuteGate"/> — delegates straight to <see cref="IMediaMuteStore.GetMutedAsync"/>
/// so <c>ActionExecutor</c>'s quickDisable check reflects whatever an operator last set via
/// <c>PUT /api/automation/media-mute</c>. A thin delegating adapter rather than making
/// <c>Narya.Database.Automation.MediaMuteStore</c> implement <see cref="IMediaMuteGate"/> directly:
/// <see cref="IMediaMuteGate"/> lives in Narya.Application (<c>IActionStepPorts.cs</c>), and
/// Narya.Database does not — and must not — reference Narya.Application (see
/// <c>Narya.Core.Automation.IMediaMuteStore</c>'s doc comment), so the adapter has to live on this
/// side of that boundary instead. Depending only on <see cref="IMediaMuteStore"/> (a Narya.Core
/// interface Narya.Application already references) keeps this class infrastructure-free itself —
/// only whatever gets registered as <see cref="IMediaMuteStore"/> needs Marten.
///
/// <para>
/// Registered with a plain <c>AddSingleton&lt;IMediaMuteGate, MediaMuteGate&gt;</c> in
/// <c>Narya.Api</c>'s <c>Program.cs</c>, inside the same <c>Narya:SkipInfrastructure</c> guard as
/// <c>AddNaryaDatabase</c> (the only source of a real <see cref="IMediaMuteStore"/>) — see that
/// file's comment. It replaces <see cref="NoopMediaMuteGate"/>'s earlier
/// <c>TryAddSingleton</c> registration from <c>AddNaryaApplication</c> via the
/// last-registration-wins rule (<c>IActionStepPorts.cs</c>'s doc comment), the same way Phase 5/8
/// will eventually replace <see cref="ITtsPort"/>/<see cref="IObsPort"/>/<see cref="ILlmPort"/>'s
/// no-ops. A <c>WebApplicationFactory</c> test under <c>Narya:SkipInfrastructure</c> never runs that
/// registration, so it keeps resolving the no-op default (never muted) unless a test substitutes
/// <see cref="IMediaMuteGate"/>/<see cref="IMediaMuteStore"/> directly.
/// </para>
/// </summary>
public sealed class MediaMuteGate(IMediaMuteStore store) : IMediaMuteGate
{
  public Task<bool> IsMutedAsync(CancellationToken cancellationToken) => store.GetMutedAsync(cancellationToken);
}
