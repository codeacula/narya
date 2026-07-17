namespace Narya.Core.Realtime;

/// <summary>
/// A no-op <see cref="IRealtimePublisher"/> registered as the DEFAULT in
/// <c>Narya.Application.ServiceCollectionExtensions.AddNaryaApplication</c> via
/// <c>TryAddSingleton</c>, so any host that composes the application layer without also
/// composing <c>Narya.Cache</c> (e.g. a future <c>Narya.Agent</c> host, or a test host under
/// <c>Narya:SkipInfrastructure</c>) can still resolve <see cref="IRealtimePublisher"/> and
/// publish notifications through <c>RealtimeBridgeHandler{T}</c> without crashing.
///
/// A host that DOES call <c>AddNaryaCache</c> gets the real
/// <c>Narya.Cache.RealtimePublisher</c> instead — <c>AddNaryaCache</c> registers it with a
/// plain <c>AddSingleton</c>, which always wins the last-registration-wins resolution rule
/// over this type's <c>TryAddSingleton</c> registration, regardless of which extension
/// method runs first (see <c>RealtimePublisherCompositionTests</c>).
/// </summary>
public sealed class NullRealtimePublisher : IRealtimePublisher
{
  public Task PublishAsync(string eventName, object payload, CancellationToken cancellationToken) =>
    Task.CompletedTask;
}
