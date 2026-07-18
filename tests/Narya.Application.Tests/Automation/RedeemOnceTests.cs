using Marten;

using MediatR;

using Microsoft.Extensions.DependencyInjection;

using NSubstitute;

using Narya.Application.Tests.Fixtures;
using Narya.Core.Actions;
using Narya.Core.Automation;
using Narya.Core.Media;
using Narya.Core.Realtime;
using Narya.Database;
using Narya.Twitch.Helix;

namespace Narya.Application.Tests.Automation;

/// <summary>
/// The redeem-once invariant — a port of legacy's <c>redeemOnce.test.ts</c> (see that file's own
/// docblock: "the migration's one unforgivable failure mode: a redeem or an alert firing twice").
/// This is deliberately an END-TO-END integration test, not a unit test of any one piece in
/// isolation: it composes the REAL <c>AddNaryaDatabase</c> stores (over Testcontainers Postgres,
/// so <c>AutomationRunDocument.DedupeKey</c>'s partial unique index — the actual dedup mechanism
/// — is exercised, not simulated) with the REAL <c>AddNaryaApplication</c> wiring (MediatR, the
/// real <see cref="Narya.Application.Automation.TriggerDispatcher"/>, the real
/// <see cref="Narya.Application.Actions.ActionExecutor"/>), and only substitutes the OUTERMOST
/// edge — <see cref="IRealtimePublisher"/> — to count what actually reaches the wire. A unit test
/// of the dispatcher or the executor alone (as <c>TriggerDispatcherTests</c>/
/// <c>ActionExecutorTests</c> already do, with doubles for each other) cannot see a second,
/// independent broadcast path the way this can — which is exactly the failure mode this guards.
///
/// <see cref="IHelixClient"/> is substituted (NSubstitute, no expectations set) purely because
/// <c>ActionExecutor</c>/<c>TriggerDispatcher</c> take it as a required constructor dependency
/// with no Null default (see <c>Narya.Application.ServiceCollectionExtensions</c>'s doc comment)
/// — neither the <c>play_media</c>/<c>show_text</c> steps under test nor
/// <c>HandleRewardRedemptionAsync</c>/<c>HandleTwitchEventAsync</c> (as opposed to
/// <c>HandleChatMessageAsync</c>'s bot-login lookup) ever call it.
/// </summary>
[Collection("postgres")]
public sealed class RedeemOnceTests(PostgresFixture fixture)
{
  private const string RewardId = "reward-double-check";

  /// <summary>A real (if minimal) in-memory recorder, not a mock — captures exactly what crossed the <see cref="IRealtimePublisher"/> boundary, in order.</summary>
  private sealed class RecordingRealtimePublisher : IRealtimePublisher
  {
    private readonly List<(string EventName, object Payload)> _events = [];
    private readonly Lock _gate = new();

    public IReadOnlyList<(string EventName, object Payload)> Events
    {
      get { lock (_gate) { return [.. _events]; } }
    }

    public Task PublishAsync(string eventName, object payload, CancellationToken cancellationToken)
    {
      lock (_gate)
      {
        _events.Add((eventName, payload));
      }

      return Task.CompletedTask;
    }
  }

  private sealed record TestHost(ServiceProvider Provider, RecordingRealtimePublisher Publisher) : IAsyncDisposable
  {
    public ValueTask DisposeAsync() => Provider.DisposeAsync();
  }

  private sealed record Seeded(MediaAsset Asset, AutomationAction RedeemAction, AutomationTrigger RewardTrigger, AutomationAction FollowAction, AutomationTrigger FollowTrigger);

  /// <summary>
  /// Composes the REAL DI graph — <c>AddNaryaDatabase</c> (Marten over the shared Testcontainers
  /// Postgres) + <c>AddNaryaApplication</c> (MediatR, the executor, the dispatcher) — then
  /// substitutes only <see cref="IHelixClient"/> (an unused required dependency — see this type's
  /// doc comment) and <see cref="IRealtimePublisher"/> (the interception point). The publisher
  /// substitution is a plain <c>AddSingleton</c> AFTER <c>AddNaryaApplication</c>'s
  /// <c>TryAddSingleton&lt;IRealtimePublisher, NullRealtimePublisher&gt;</c>, so it wins
  /// last-registration-wins — the identical pattern
  /// <c>RealtimePublisherCompositionTests</c> already proves for <c>AddNaryaCache</c>.
  /// </summary>
  private async Task<TestHost> BuildHostAsync()
  {
    var publisher = new RecordingRealtimePublisher();
    var services = new ServiceCollection();
    _ = services.AddLogging();
    _ = services.AddNaryaDatabase(fixture.ConnectionString);
    _ = services.AddNaryaApplication();
    _ = services.AddSingleton(Substitute.For<IHelixClient>());
    _ = services.AddSingleton<IRealtimePublisher>(publisher);

    var provider = services.BuildServiceProvider();

    // Fresh schema + a clean slate per test — mirrors every other Testcontainers-backed store
    // test's BuildCleanDocumentStoreAsync (e.g. AutomationRunStoreTests), so triggers/actions
    // seeded by one test can never leak into another sharing the same container.
    var documentStore = provider.GetRequiredService<IDocumentStore>();
    await documentStore.Storage.ApplyAllConfiguredChangesToDatabaseAsync().ConfigureAwait(false);
    await documentStore.Advanced.Clean.DeleteAllEventDataAsync(CancellationToken.None).ConfigureAwait(false);
    await documentStore.Advanced.Clean.DeleteAllDocumentsAsync(CancellationToken.None).ConfigureAwait(false);

    return new TestHost(provider, publisher);
  }

  /// <summary>
  /// Seeds through the REAL stores (<see cref="IMediaAssetStore"/>/<see cref="IActionStore"/>/
  /// <see cref="IAutomationTriggerStore"/>), never by hand-constructing documents — the operator's
  /// real shape: one remote media asset, a <c>reward</c> trigger with a single-step
  /// <c>play_media</c> Action, and a <c>twitch_event</c> (follow) trigger with a
  /// <c>show_text</c> + <c>play_media</c> Action. Cooldowns are 0 on both triggers so the
  /// redelivery assertion (Test 3) isolates the DEDUP claim as the thing blocking the second run
  /// — a nonzero cooldown would also block a same-trigger redelivery and produce a false pass.
  /// </summary>
  private static async Task<Seeded> SeedAsync(IServiceProvider provider, CancellationToken cancellationToken)
  {
    var mediaAssetStore = provider.GetRequiredService<IMediaAssetStore>();
    var actionStore = provider.GetRequiredService<IActionStore>();
    var triggerStore = provider.GetRequiredService<IAutomationTriggerStore>();

    var assetResult = await mediaAssetStore.CreateAsync(
      new MediaAssetPatch
      {
        Label = "Dinosaur",
        Kind = MediaKind.Video,
        SourceType = MediaSourceType.Remote,
        Src = "https://example.com/dinosaur.mp4",
        Volume = 1.0,
        Enabled = true,
      },
      cancellationToken).ConfigureAwait(false);
    Assert.True(assetResult.IsSuccess, FirstError(assetResult.Errors));
    var asset = assetResult.Value;

    var redeemActionResult = await actionStore.CreateAsync(
      new ActionUpsert
      {
        Name = "Play Dinosaur Clip",
        Enabled = true,
        Steps = [new PlayMediaActionStep { AssetIds = [asset.Id], Selection = MediaSelection.First }],
      },
      cancellationToken).ConfigureAwait(false);
    Assert.True(redeemActionResult.IsSuccess, FirstError(redeemActionResult.Errors));
    var redeemAction = redeemActionResult.Value;

    var rewardTriggerResult = await triggerStore.CreateAsync(
      new AutomationTriggerUpsert
      {
        ActionId = redeemAction.Id,
        GlobalCooldownMs = 0,
        UserCooldownMs = 0,
        Config = new RewardTriggerConfig { RewardId = RewardId },
      },
      cancellationToken).ConfigureAwait(false);
    Assert.True(rewardTriggerResult.IsSuccess, FirstError(rewardTriggerResult.Errors));

    var followActionResult = await actionStore.CreateAsync(
      new ActionUpsert
      {
        Name = "Follow Alert",
        Enabled = true,
        Steps =
        [
          new ShowTextActionStep { Template = "{actor} just followed!", DurationMs = 6000, Style = TextStyle.Banner },
          new PlayMediaActionStep { AssetIds = [asset.Id], Selection = MediaSelection.First },
        ],
      },
      cancellationToken).ConfigureAwait(false);
    Assert.True(followActionResult.IsSuccess, FirstError(followActionResult.Errors));
    var followAction = followActionResult.Value;

    var followTriggerResult = await triggerStore.CreateAsync(
      new AutomationTriggerUpsert
      {
        ActionId = followAction.Id,
        GlobalCooldownMs = 0,
        UserCooldownMs = 0,
        Config = new TwitchEventTriggerConfig { EventKind = TwitchAlertEventKind.Follow },
      },
      cancellationToken).ConfigureAwait(false);
    Assert.True(followTriggerResult.IsSuccess, FirstError(followTriggerResult.Errors));

    return new Seeded(asset, redeemAction, rewardTriggerResult.Value, followAction, followTriggerResult.Value);
  }

  private static string FirstError(IEnumerable<FluentResults.IError> errors) =>
    string.Join("; ", errors.Select(e => e.Message));

  // ---------------------------------------------------------------------------------------
  // 1. A redeem plays media EXACTLY ONCE — proves there is only one playback path (the
  //    trigger -> Action), no second reward-binding path double-playing the same redeem.
  // ---------------------------------------------------------------------------------------

  [Fact]
  public async Task ARedeemPlaysMediaExactlyOnce()
  {
    await using var host = await BuildHostAsync();
    var seeded = await SeedAsync(host.Provider, CancellationToken.None);
    var mediator = host.Provider.GetRequiredService<IMediator>();

    await mediator.Publish(
      new RewardRedeemedSignalNotification("evt-redeem-1", RewardId, "Play a clip", "Sorlus", "sorlus", null),
      CancellationToken.None);

    var plays = host.Publisher.Events.Where(e => e.EventName == "media:play").ToList();

    // Two would mean a second path also plays the redeem's media alongside the reward trigger —
    // exactly the double-play regression this test exists to catch.
    _ = Assert.Single(plays);
    var payload = Assert.IsType<MediaPlayback>(plays[0].Payload);
    Assert.Equal(seeded.Asset.Src, payload.Src);
  }

  // ---------------------------------------------------------------------------------------
  // 2. A follow fires overlay:text + media:play EXACTLY ONCE each — and no retired-path event
  //    name exists anywhere in the codebase (structurally guaranteed by RealtimeEventNames).
  // ---------------------------------------------------------------------------------------

  [Fact]
  public async Task AFollowFiresOverlayTextPlusMediaExactlyOnceEach()
  {
    await using var host = await BuildHostAsync();
    _ = await SeedAsync(host.Provider, CancellationToken.None);
    var mediator = host.Provider.GetRequiredService<IMediator>();

    await mediator.Publish(
      new TwitchEventSignalNotification(TwitchAlertEventKind.Follow, "evt-follow-1", "Sorlus", "sorlus", null, null, null),
      CancellationToken.None);

    var overlayTextEvents = host.Publisher.Events.Where(e => e.EventName == "overlay:text").ToList();
    var mediaPlayEvents = host.Publisher.Events.Where(e => e.EventName == "media:play").ToList();

    _ = Assert.Single(overlayTextEvents);
    _ = Assert.Single(mediaPlayEvents);
    var overlayPayload = Assert.IsType<OverlayTextPlayback>(overlayTextEvents[0].Payload);
    Assert.Equal("Sorlus just followed!", overlayPayload.Text);

    // The retired legacy alerts module broadcast `alert:show`; nothing in the C# codebase does —
    // RealtimeEventNames.OverlayAllowlist is the fixed, exhaustive set of every realtime event
    // name Narya.Application ever forwards through IRealtimePublisher (see that type's own doc
    // comment), so its NOT containing "alert:show"/"alert:play" is a structural guarantee, not
    // just an absence in this run. Asserted against the actual recorded broadcasts too.
    Assert.DoesNotContain("alert:show", RealtimeEventNames.OverlayAllowlist);
    Assert.DoesNotContain("alert:play", RealtimeEventNames.OverlayAllowlist);
    Assert.DoesNotContain(host.Publisher.Events, e => e.EventName is "alert:show" or "alert:play");
  }

  // ---------------------------------------------------------------------------------------
  // 3. A REDELIVERED signal (same eventId) does NOT replay media:play — proves the
  //    automation_runs partial-unique-index dedup against a real Postgres redelivery.
  // ---------------------------------------------------------------------------------------

  [Fact]
  public async Task ARedeliveredSignalDoesNotReplayTheRedeem()
  {
    await using var host = await BuildHostAsync();
    _ = await SeedAsync(host.Provider, CancellationToken.None);
    var mediator = host.Provider.GetRequiredService<IMediator>();
    var notification = new RewardRedeemedSignalNotification("evt-redeem-dupe", RewardId, "Play a clip", "Sorlus", "sorlus", null);

    await mediator.Publish(notification, CancellationToken.None);
    _ = Assert.Single(host.Publisher.Events, e => e.EventName == "media:play");

    // Same message id: Twitch redelivering, not a second redemption.
    await mediator.Publish(notification, CancellationToken.None);

    _ = Assert.Single(host.Publisher.Events, e => e.EventName == "media:play");
  }
}
