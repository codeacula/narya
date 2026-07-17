using Marten;

using Microsoft.Extensions.DependencyInjection;

using Narya.Twitch.Tokens;

namespace Narya.Twitch;

public static class ServiceCollectionExtensions
{
  public static IServiceCollection AddNaryaTwitch(this IServiceCollection services)
  {
    // Additive Marten configuration — see NaryaTwitchMartenConfig's doc comment for why
    // this goes through Marten's ConfigureMarten DI hook instead of a direct reference
    // from Narya.Database's NaryaMartenConfig.
    _ = services.ConfigureMarten(NaryaTwitchMartenConfig.Configure);

    _ = services.AddSingleton<ITwitchTokenStore, TwitchTokenStore>();

    return services;
  }
}
