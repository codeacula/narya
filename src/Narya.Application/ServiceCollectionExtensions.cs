using FluentValidation;

using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

using Narya.Application.Actions;
using Narya.Application.Automation;
using Narya.Application.Behaviors;
using Narya.Core.Dashboard;
using Narya.Core.Media;
using Narya.Core.Realtime;
using Narya.Core.Twitch;

namespace Narya.Application;

public static class ServiceCollectionExtensions
{
  public static IServiceCollection AddNaryaApplication(this IServiceCollection services)
  {
    _ = services.AddValidatorsFromAssemblyContaining<NaryaApplication>();
    _ = services.AddMediatR(cfg =>
    {
      _ = cfg.RegisterServicesFromAssemblyContaining<NaryaApplication>();
      _ = cfg.AddOpenBehavior(typeof(LoggingBehavior<,>));
      _ = cfg.AddOpenBehavior(typeof(ValidationBehavior<,>));
    });

    // NOT also registered explicitly here: MediatR's assembly scan
    // (RegisterServicesFromAssemblyContaining above) already discovers the open generic
    // RealtimeBridgeHandler<T> despite its extra IRealtimeNotification constraint —
    // confirmed empirically by RealtimeBridgeHandlerTests, which resolves
    // INotificationHandler<AppConfigUpdatedNotification> and asserts exactly one
    // instance. Adding a second, explicit AddTransient(typeof(INotificationHandler<>),
    // typeof(RealtimeBridgeHandler<>)) registration here would double that to two
    // handlers, and MediatR invokes every registered handler for a Publish — silently
    // double-publishing every realtime event to Redis.

    // TryAddSingleton, not AddSingleton: RealtimeBridgeHandler<T> hard-depends on
    // IRealtimePublisher, so any host that composes AddNaryaApplication without also
    // composing Narya.Cache's AddNaryaCache (a future Narya.Agent host; a WebApplicationFactory
    // test host under Narya:SkipInfrastructure) would otherwise crash the first time it
    // publishes a realtime notification. TryAdd is a no-op when AddNaryaCache already
    // registered the real RealtimePublisher (whether AddNaryaCache ran before or after this
    // call — see RealtimePublisherCompositionTests), so a host with both always resolves the
    // real publisher, never this default.
    services.TryAddSingleton<IRealtimePublisher, NullRealtimePublisher>();

    // TryAddSingleton: StreamOfflineHandler (Sessions) depends on TimeProvider. Narya.Twitch
    // also TryAdds TimeProvider.System (for TwitchCredentials) but Narya.Application must not
    // rely on Narya.Twitch's registration having run first — a host that composes
    // AddNaryaApplication without AddNaryaTwitch (a future Narya.Agent host; a
    // WebApplicationFactory test under Narya:SkipInfrastructure) still needs a working clock
    // the first time it publishes StreamOfflineNotification.
    services.TryAddSingleton(TimeProvider.System);

    // TryAddSingleton, same rationale as IRealtimePublisher above:
    // GetDashboardStatusQueryHandler hard-depends on IDashboardTwitchStatusProvider, so a host
    // that composes AddNaryaApplication without also composing Narya.Twitch's AddNaryaTwitch
    // (a WebApplicationFactory test under Narya:SkipInfrastructure) still needs something to
    // resolve. See NullDashboardTwitchStatusProvider's doc comment.
    services.TryAddSingleton<IDashboardTwitchStatusProvider, NullDashboardTwitchStatusProvider>();

    // TryAddSingleton, same rationale as IRealtimePublisher/IDashboardTwitchStatusProvider
    // above: UpdateAppConfigCommandHandler hard-depends on ITwitchIdentityInvalidator so a
    // channel/credentials change drops the cached broadcaster id, app token, and bot login. A
    // host that composes AddNaryaApplication without AddNaryaTwitch (Narya.Agent; a
    // WebApplicationFactory test under Narya:SkipInfrastructure) has no such caches, so the
    // no-op is the correct answer there — see NullTwitchIdentityInvalidator's doc comment.
    // AddNaryaTwitch registers the real TwitchIdentityInvalidator with a plain AddSingleton,
    // which wins over this regardless of composition order.
    services.TryAddSingleton<ITwitchIdentityInvalidator, NullTwitchIdentityInvalidator>();

    // TryAddSingleton, same rationale as IRealtimePublisher/IDashboardTwitchStatusProvider above:
    // Narya.Api.Controllers.MediaAssetsController hard-depends on IMediaFileCatalog (and, once
    // AddNaryaDatabase does run, so does Narya.Database.Media.MediaAssetStore), so a host that
    // composes AddNaryaApplication without also composing Narya.Database's AddNaryaDatabase — a
    // WebApplicationFactory test under Narya:SkipInfrastructure — still needs something to
    // resolve the controller's constructor. See NullMediaFileCatalog's doc comment for why Phase 4
    // ships only this default (Phase 5 owns the real filesystem/companion catalog, registered
    // with a plain AddSingleton that always wins over this TryAddSingleton).
    services.TryAddSingleton<IMediaFileCatalog, NullMediaFileCatalog>();

    // Phase 4 Task 3: no-op defaults for capabilities not built yet (Phase 5's TTS/OBS
    // companion, Phase 8's LLM, Phase 4 Task 4's real media-mute store) plus the real
    // (non-infrastructure) implementations of ActionExecutor's delay/random-selection
    // testability seams — TryAddSingleton for the same reason as every other default on this
    // page: ActionExecutor is registered unconditionally below, so any host composing
    // AddNaryaApplication (including a WebApplicationFactory test under
    // Narya:SkipInfrastructure) needs something to resolve for these constructor
    // dependencies. See IActionStepPorts.cs's top-of-file doc comment.
    services.TryAddSingleton<ITtsPort, NoopTtsPort>();
    services.TryAddSingleton<ILlmPort, NoopLlmPort>();
    services.TryAddSingleton<IObsPort, NoopObsPort>();
    services.TryAddSingleton<IMediaMuteGate, NoopMediaMuteGate>();
    services.TryAddSingleton<IActionDelay, SystemActionDelay>();
    services.TryAddSingleton<IRandomIndexSource, SystemRandomIndexSource>();

    // Plain AddSingleton, unlike the defaults above: the executor itself needs no
    // infrastructure — only some of ITS OWN dependencies do (IActionStore, IMediaResolver,
    // IHelixClient have real implementations only once AddNaryaDatabase/AddNaryaTwitch compose,
    // and deliberately have no Null default — see the Phase 4 Task 3 report). A host that skips
    // those (a WebApplicationFactory test under Narya:SkipInfrastructure) must substitute all
    // three directly, the same way ActionsControllerTests/AutomodControllerTests already
    // substitute IActionStore/IHelixClient.
    _ = services.AddSingleton<IActionExecutor, ActionExecutor>();

    // Phase 4 Task 6: same rationale as IActionExecutor immediately above — the dispatcher
    // itself needs no infrastructure, only its own dependencies do. IAutomationTriggerStore and
    // IAutomationRunStore have real implementations only once AddNaryaDatabase composes and
    // deliberately have no Null default (a WebApplicationFactory test under
    // Narya:SkipInfrastructure must substitute both directly, the same way it already substitutes
    // IActionStore/IMediaResolver/IHelixClient) — this is what turns "ChatMessageTriggerHandler
    // depends on ITriggerDispatcher" into every WAF test needing those two stores substituted,
    // not just AutomationTriggersControllerTests.
    _ = services.AddSingleton<ITriggerDispatcher, TriggerDispatcher>();

    // TryAddSingleton: Phase 8 owns the real category-module coordinator; until then every
    // module-scoped trigger stays dormant (never armed) — see IActiveModuleProvider's doc
    // comment, same no-op-default family as ITtsPort/ILlmPort/IObsPort above.
    services.TryAddSingleton<IActiveModuleProvider, NullActiveModuleProvider>();

    return services;
  }
}
