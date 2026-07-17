using Marten;

using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

using Narya.Core.AppConfig;
using Narya.Twitch.Oauth;
using Narya.Twitch.Tokens;

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

    return services;
  }
}
