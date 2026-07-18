namespace Narya.Core.Dashboard;

/// <summary>
/// A "not authenticated, EventSub not connected" default <see cref="IDashboardTwitchStatusProvider"/>,
/// registered via <c>TryAddSingleton</c> in
/// <c>Narya.Application.ServiceCollectionExtensions.AddNaryaApplication</c> — mirrors
/// <see cref="Narya.Core.Realtime.NullRealtimePublisher"/>'s exact rationale (see that class's
/// doc comment): <c>GetDashboardStatusQueryHandler</c> hard-depends on
/// <see cref="IDashboardTwitchStatusProvider"/>, so any host that composes
/// <c>AddNaryaApplication</c> without also composing Narya.Twitch's <c>AddNaryaTwitch</c> — a
/// <c>WebApplicationFactory</c> test host under <c>Narya:SkipInfrastructure</c>, or a future host
/// with no Twitch integration — would otherwise fail DI validation the moment anything resolves
/// <c>GetDashboardStatusQueryHandler</c> (or, with <c>ValidateOnBuild</c>, at host startup even
/// if nothing ever calls it). This default reports every Twitch/EventSub field as its honest
/// "nothing configured" value instead.
///
/// A host that DOES call <c>AddNaryaTwitch</c> gets the real
/// <c>Narya.Twitch.Dashboard.TwitchDashboardStatusProvider</c> instead — <c>AddNaryaTwitch</c>
/// registers it with a plain <c>AddSingleton</c>, which always wins the last-registration-wins
/// resolution rule over this type's <c>TryAddSingleton</c> registration, regardless of which
/// extension method runs first (same guarantee <c>RealtimePublisherCompositionTests</c> proves
/// for <see cref="Narya.Core.Realtime.IRealtimePublisher"/>).
/// </summary>
public sealed class NullDashboardTwitchStatusProvider : IDashboardTwitchStatusProvider
{
  public Task<DashboardTwitchStatus> GetAsync(CancellationToken cancellationToken) =>
    Task.FromResult(new DashboardTwitchStatus
    {
      TwitchAuthenticated = false,
      TwitchAuthSource = null,
      TwitchTokenExpiresAt = null,
      TwitchMissingScopes = [],
      TwitchBotAuthenticated = false,
      TwitchBotAuthSource = null,
      TwitchBotTokenExpiresAt = null,
      TwitchBotMissingScopes = [],
      EventSubConnected = false,
      EventSubError = null,
      EventSubFailedSubscriptions = [],
    });
}
