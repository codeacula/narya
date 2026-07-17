using Marten;

using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

using Narya.Core.AppConfig;
using Narya.Twitch.EventSub;
using Narya.Twitch.Helix;
using Narya.Twitch.Oauth;
using Narya.Twitch.Tokens;

using TwitchLib.Api;

namespace Narya.Twitch;

public static class ServiceCollectionExtensions
{
  /// <summary>Name of the <see cref="IHttpClientFactory"/> client used for Twitch's OAuth token endpoint.</summary>
  public const string OAuthHttpClientName = "twitch-oauth";

  public static IServiceCollection AddNaryaTwitch(this IServiceCollection services)
  {
    // Additive Marten configuration — see NaryaTwitchMartenConfig's doc comment for why
    // this goes through Marten's ConfigureMarten DI hook instead of a direct reference
    // from Narya.Database's NaryaMartenConfig.
    _ = services.ConfigureMarten(NaryaTwitchMartenConfig.Configure);

    _ = services.AddSingleton<ITwitchTokenStore, TwitchTokenStore>();

    // TwitchOAuthClient takes a plain HttpClient (so tests can build one on a fake
    // HttpMessageHandler with no real network) rather than IHttpClientFactory directly, so
    // production resolves the named client once here and wraps it — the factory is what
    // gives the underlying handler its pooling/rotation behavior even though the resulting
    // HttpClient instance is then held for the app's lifetime inside the singleton below.
    _ = services.AddHttpClient(OAuthHttpClientName);
    _ = services.AddSingleton<ITwitchOAuthClient>(sp => new TwitchOAuthClient(
      sp.GetRequiredService<IHttpClientFactory>().CreateClient(OAuthHttpClientName),
      sp.GetRequiredService<IAppConfigStore>()));

    // TwitchCredentials caches the app access token and the broadcaster id in memory, so it
    // must be a singleton — TryAdd rather than Add so a host that already registered its own
    // TimeProvider (e.g. for testing) is not overridden.
    services.TryAddSingleton(TimeProvider.System);
    _ = services.AddSingleton<ITwitchCredentials, TwitchCredentials>();

    // The single TwitchAPI instance every Helix call shares. Secret is deliberately left
    // unset (setting it would enable TwitchLib's own app-token auto-minting) and
    // SkipAutoServerTokenGeneration/SkipDynamicScopeValidation are set once, here, since they
    // never change. ClientId is intentionally NOT set here — it may be empty at process
    // startup (the operator configures it later, in Settings) and IAppConfigStore.GetAsync is
    // async, so it can't be read inside this synchronous factory anyway. TwitchLibHelixApi
    // refreshes Settings.ClientId from AppConfig on every call instead. Settings.AccessToken
    // is never set — every call passes a fresh per-call token instead (twitchlib-spec.md §2).
    _ = services.AddSingleton(_ =>
    {
      var api = new TwitchAPI();
      api.Settings.SkipAutoServerTokenGeneration = true;
      api.Settings.SkipDynamicScopeValidation = true;
      return api;
    });
    _ = services.AddSingleton<IHelixApi, TwitchLibHelixApi>();

    _ = services.AddSingleton(sp => new HelixClient(
      sp.GetRequiredService<IHelixApi>(),
      sp.GetRequiredService<ITwitchCredentials>(),
      sp.GetRequiredService<IAppConfigStore>(),
      sp.GetRequiredService<TimeProvider>()));
    _ = services.AddSingleton<IHelixClient>(sp => sp.GetRequiredService<HelixClient>());

    // Closes the IBroadcasterIdResolver gap TwitchCredentials (Task 2) left open: registered
    // via BroadcasterIdResolverAdapter rather than the HelixClient singleton directly — see
    // that class's doc comment for why a direct registration deadlocks the container instead
    // of failing fast.
    _ = services.AddSingleton<IBroadcasterIdResolver, BroadcasterIdResolverAdapter>();

    // TryAdd: Phase 2 Task 5 swaps this line for the real TwitchEventSubWebSocket transport
    // (AddSingleton/Replace) — TryAdd here means a host that registers its own
    // ITwitchEventSource first (e.g. a test) is never overridden by this default.
    services.TryAddSingleton<ITwitchEventSource, NoopTwitchEventSource>();

    return services;
  }
}
