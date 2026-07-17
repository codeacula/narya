using FluentResults;

using Microsoft.Extensions.DependencyInjection;

using Narya.Twitch.Tokens;

namespace Narya.Twitch.Helix;

/// <summary>
/// The <see cref="IBroadcasterIdResolver"/> registration <c>ServiceCollectionExtensions.AddNaryaTwitch</c>
/// actually wires up. <see cref="HelixClient"/> itself also implements
/// <see cref="IBroadcasterIdResolver"/> (identical method signature to
/// <see cref="IHelixClient.GetBroadcasterIdAsync"/>), but registering
/// <c>IBroadcasterIdResolver → HelixClient</c> directly creates a genuine DI construction
/// cycle: <c>TwitchCredentials</c>'s constructor requires <see cref="IBroadcasterIdResolver"/>,
/// and <see cref="HelixClient"/>'s constructor requires <see cref="ITwitchCredentials"/> (to
/// build action credentials for its other endpoints) — resolving either singleton first would
/// need the other to already exist. Verified empirically: that direct registration does not
/// throw a helpful "circular dependency" exception, it just <b>hangs</b> (Microsoft.Extensions.DependencyInjection's
/// singleton lock is re-entrant on the constructing thread, so the nested resolution silently
/// recurses instead of failing fast).
///
/// This adapter breaks the cycle: it depends only on <see cref="IServiceProvider"/>, resolved
/// once at DI-graph-build time with no dependency of its own, and defers the actual
/// <see cref="IHelixClient"/> lookup to first *call*, by which point both singletons already
/// exist in the container's cache. The lookup still resolves to the exact same
/// <see cref="HelixClient"/> singleton instance registered for <see cref="IHelixClient"/> (see
/// <c>ServiceCollectionExtensionsTests</c>, which proves this via a live
/// <c>ServiceProvider</c>), so <c>TwitchCredentials</c>'s broadcaster-id cache and
/// <see cref="HelixClient"/>'s own field cache are one and the same.
/// </summary>
internal sealed class BroadcasterIdResolverAdapter(IServiceProvider serviceProvider) : IBroadcasterIdResolver
{
  public Task<Result<string>> GetBroadcasterIdAsync(CancellationToken cancellationToken) =>
    serviceProvider.GetRequiredService<IHelixClient>().GetBroadcasterIdAsync(cancellationToken);
}
