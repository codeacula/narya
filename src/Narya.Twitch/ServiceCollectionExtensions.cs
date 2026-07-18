using Marten;

using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

using Narya.Core.AppConfig;
using Narya.Core.Dashboard;
using Narya.Twitch.Chat;
using Narya.Twitch.Dashboard;
using Narya.Twitch.EventSub;
using Narya.Twitch.Helix;
using Narya.Twitch.Oauth;
using Narya.Twitch.Tokens;

using TwitchLib.Api;
using TwitchLib.EventSub.Websockets;
using TwitchLib.EventSub.Websockets.Extensions;

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

    // TryAdd: AddNaryaTwitchEventSub (below) Replaces this with the real transport for a
    // host that opts in — TryAdd here means a host that registers its own
    // ITwitchEventSource first (e.g. a test) is never overridden by this default.
    services.TryAddSingleton<ITwitchEventSource, NoopTwitchEventSource>();

    // Phase 3 Task 7: the Twitch-auth/EventSub half of DashboardStatus. Depends only on
    // ITwitchTokenStore (registered above) and ITwitchEventSource (whichever variant is
    // registered — Noop here, or the real one after AddNaryaTwitchEventSub replaces it), so it
    // is safe to register unconditionally in AddNaryaTwitch rather than needing the real
    // EventSub opt-in.
    _ = services.AddSingleton<IDashboardTwitchStatusProvider, TwitchDashboardStatusProvider>();

    // Stateless (every member is a pure function of its arguments — see ChatRoleResolver's doc
    // comment), so a singleton is safe. Nothing in Phase 2 resolves this via DI yet —
    // EventSubDispatcher calls ChatRoleResolver's static methods directly, since it must stay a
    // pure, DI-free static class — but a future phase (a viewer-command role check, a dashboard
    // viewer-roster column) needs it injectable, and registering it now means that phase needs
    // no DI change of its own.
    _ = services.AddSingleton<IChatRoleResolver, ChatRoleResolver>();

    return services;
  }

  /// <summary>
  /// Adds the real Twitch EventSub websocket transport: TwitchLib's
  /// <c>EventSubWebsocketClient</c> singleton, the <see cref="TwitchEventSubService"/>
  /// hosted service that connects it at boot and owns its reconnect/re-subscribe behavior, and
  /// <see cref="TwitchEventSource"/> in place of <see cref="NoopTwitchEventSource"/>.
  ///
  /// Deliberately NOT folded into <see cref="AddNaryaTwitch"/> itself: <c>AddNaryaTwitch</c>
  /// is called directly — with no host, no <c>IHost.StartAsync</c>, nothing that would ever
  /// actually run a hosted service — by unit tests exercising the rest of this DI graph (see
  /// <c>ServiceCollectionExtensionsTests</c>) and would be by a future Narya.Agent host that
  /// has no business opening a Twitch socket of its own. A hosted-service registration sitting
  /// unused in that container is harmless by itself, but registering the real
  /// <see cref="ITwitchEventSource"/> there too would mean any such caller silently stops
  /// getting <see cref="NoopTwitchEventSource"/>'s safe do-nothing behavior. Keeping this a
  /// separate, explicitly-opted-into method means the only thing that ever calls it is
  /// <c>Narya.Api.Program</c>, inside the same <c>Narya:SkipInfrastructure</c> guard that
  /// already wraps <see cref="AddNaryaTwitch"/> — so a WebApplicationFactory test that sets
  /// that flag never reaches this method, and never opens a real socket, without needing any
  /// EventSub-specific guard of its own.
  ///
  /// Must be called after <see cref="AddNaryaTwitch"/> (it depends on
  /// <see cref="ITwitchCredentials"/> and <see cref="Helix.IHelixClient"/>, and replaces that
  /// call's <see cref="NoopTwitchEventSource"/> registration).
  /// </summary>
  public static IServiceCollection AddNaryaTwitchEventSub(this IServiceCollection services)
  {
    _ = services.AddTwitchLibEventSubWebsockets();

    // Registered as itself, not just as IHostedService: TwitchEventSource (below) needs the
    // SAME singleton instance to read Status from — AddHostedService<T> alone only exposes T
    // through IHostedService, which is not resolvable by its concrete type. The factory
    // registration just below reuses this exact instance as the hosted service, so there is
    // still only ever one TwitchEventSubService for the process, whichever way it is resolved.
    _ = services.AddSingleton<TwitchEventSubService>();
    _ = services.AddHostedService(sp => sp.GetRequiredService<TwitchEventSubService>());

    // Replace, not TryAdd: this call's entire purpose is to swap out the
    // NoopTwitchEventSource AddNaryaTwitch registered.
    _ = services.Replace(ServiceDescriptor.Singleton<ITwitchEventSource, TwitchEventSource>());

    return services;
  }
}
