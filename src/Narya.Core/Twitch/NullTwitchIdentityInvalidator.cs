namespace Narya.Core.Twitch;

/// <summary>
/// The do-nothing <see cref="ITwitchIdentityInvalidator"/> a host with no Twitch layer at all
/// resolves — <c>Narya.Agent</c> (which composes <c>AddNaryaApplication</c> without
/// <c>AddNaryaTwitch</c>) and any <c>WebApplicationFactory</c> test running under
/// <c>Narya:SkipInfrastructure</c>. There is no cached Twitch identity in such a host, so
/// there is nothing to invalidate; doing nothing is the correct answer, not a degraded one.
/// Registered via <c>TryAddSingleton</c> in <c>AddNaryaApplication</c>, exactly as
/// <see cref="Realtime.NullRealtimePublisher"/> is, so <c>AddNaryaTwitch</c>'s plain
/// <c>AddSingleton</c> of the real implementation always wins when both compose.
/// </summary>
public sealed class NullTwitchIdentityInvalidator : ITwitchIdentityInvalidator
{
  public Task InvalidateAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}
