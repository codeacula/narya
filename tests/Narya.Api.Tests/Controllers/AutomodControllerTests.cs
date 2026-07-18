using System.Net;
using System.Net.Http.Headers;

using FluentResults;

using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;

using Narya.Api.Auth;
using Narya.Core.Actions;
using Narya.Core.AppConfig;
using Narya.Core.Automation;
using Narya.Core.Automod;
using Narya.Core.Chat;
using Narya.Core.Events;
using Narya.Core.Media;
using Narya.Core.Sessions;
using Narya.Core.Viewers;
using Narya.Twitch.Helix;

using NSubstitute;

using DomainConfig = Narya.Domain.AppConfig.AppConfig;

namespace Narya.Api.Tests.Controllers;

/// <summary>
/// Exercises <c>/api/automod/queue</c> and <c>/api/automod/{id}/allow|deny</c> through a real
/// host under <c>Narya:SkipInfrastructure=true</c>. <see cref="IAutomodStore"/> and
/// <see cref="IHelixClient"/> are substituted with controlled instances (via
/// <c>ConfigureTestServices</c>) — neither <c>AddNaryaDatabase</c> nor <c>AddNaryaTwitch</c> runs
/// under the infrastructure guard, and <c>AutomodController</c> resolves both directly (it
/// bypasses MediatR for the allow/deny orchestration — see that controller's doc comment).
/// <see cref="IAppConfigStore"/>/<see cref="IStreamSessionStore"/>/<see cref="IChatStore"/>/
/// <see cref="IStreamEventStore"/>/<see cref="IViewerStore"/> are also substituted (unconfigured
/// — nothing here exercises them), same reason as <c>ConfigControllerTests</c>. Both routes are
/// operator-only — deliberately NOT on <c>DashboardTokenMiddleware.OverlayPaths</c> — so the
/// overlay-token case asserts 403, mirroring <c>DashboardControllerTests</c>.
/// </summary>
public sealed class AutomodControllerTests
{
  private const string OperatorToken = "op-token";

  private static (HttpClient Client, IAutomodStore Store, IHelixClient Helix) BuildOperatorClient()
  {
    var automodStore = Substitute.For<IAutomodStore>();
    var helixClient = Substitute.For<IHelixClient>();
    var appConfigStore = Substitute.For<IAppConfigStore>();
    _ = appConfigStore.GetAsync(Arg.Any<CancellationToken>())
      .Returns(Result.Ok(new DomainConfig { TwitchChannel = "codeacula" }));

    var client = new WebApplicationFactory<Program>()
      .WithWebHostBuilder(b =>
      {
        _ = b.UseSetting("Narya:DashboardToken", OperatorToken);
        _ = b.UseSetting("Narya:SkipInfrastructure", "true");

        _ = b.ConfigureTestServices(services =>
        {
          _ = services.AddSingleton(automodStore);
          _ = services.AddSingleton(helixClient);
          _ = services.AddSingleton(appConfigStore);
          _ = services.AddSingleton(Substitute.For<IStreamSessionStore>());
          _ = services.AddSingleton(Substitute.For<IChatStore>());
          _ = services.AddSingleton(Substitute.For<IStreamEventStore>());
          _ = services.AddSingleton(Substitute.For<IViewerStore>());
          _ = services.AddSingleton(Substitute.For<IMediaAssetStore>());
          _ = services.AddSingleton(Substitute.For<IActionStore>());
          _ = services.AddSingleton(Substitute.For<IMediaResolver>());
          _ = services.AddSingleton(Substitute.For<IMediaMuteStore>());
        });
      })
      .CreateClient();

    client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", OperatorToken);
    return (client, automodStore, helixClient);
  }

  private static AutomodHold BuildHold(
    string id = "held-1", DateTimeOffset? resolvedAt = null, string? resolution = null, string? resolvedBy = null) => new(
      Id: id, Channel: "codeacula", Username: "viewer", DisplayName: "Viewer", Message: "hi",
      Category: null, Level: null, HeldAt: DateTimeOffset.UtcNow,
      ResolvedAt: resolvedAt, Resolution: resolution, ResolvedBy: resolvedBy);

  [Fact]
  public async Task GetQueueReturnsTheStoresQueue()
  {
    var (client, store, _) = BuildOperatorClient();
    var queue = new AutomodQueue([BuildHold()], []);
    // GetAutomodQueueQueryHandler sweeps first — an empty sweep here means the real handler
    // publishes nothing and just returns the stubbed queue below.
    _ = store.SweepExpiredHoldsAsync(Arg.Any<CancellationToken>()).Returns([]);
    _ = store.GetQueueAsync(Arg.Any<CancellationToken>()).Returns(queue);

    var response = await client.GetAsync("/api/automod/queue");

    Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    var body = await response.Content.ReadAsStringAsync();
    Assert.Contains("\"id\":\"held-1\"", body);
  }

  [Fact]
  public async Task GetQueueIsForbiddenWithAnOverlayToken()
  {
    var (client, store, _) = BuildOperatorClient();
    var overlay = OverlayToken.Derive(OperatorToken);
    client.DefaultRequestHeaders.Authorization = null;

    var response = await client.GetAsync($"/api/automod/queue?token={overlay}");

    Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    _ = await store.DidNotReceive().GetQueueAsync(Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task AllowUnknownIdReturnsNotFoundWithoutCallingHelix()
  {
    var (client, store, helix) = BuildOperatorClient();
    _ = store.GetHoldAsync("missing", Arg.Any<CancellationToken>()).Returns((AutomodHold?)null);

    var response = await client.PostAsync("/api/automod/missing/allow", null);

    Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    _ = await helix.DidNotReceive().ResolveAutomodMessageAsync(Arg.Any<string>(), Arg.Any<bool>(), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task AllowAlreadyResolvedReturnsIdempotentlyWithoutCallingHelix()
  {
    var (client, store, helix) = BuildOperatorClient();
    var resolved = BuildHold(resolvedAt: DateTimeOffset.UtcNow, resolution: "denied", resolvedBy: "codeacula");
    _ = store.GetHoldAsync("held-1", Arg.Any<CancellationToken>()).Returns(resolved);

    var response = await client.PostAsync("/api/automod/held-1/allow", null);

    Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    var body = await response.Content.ReadAsStringAsync();
    Assert.Contains("\"resolution\":\"denied\"", body);
    _ = await helix.DidNotReceive().ResolveAutomodMessageAsync(Arg.Any<string>(), Arg.Any<bool>(), Arg.Any<CancellationToken>());
    _ = await store.DidNotReceive().ResolveHoldAsync(
      Arg.Any<string>(), Arg.Any<string>(), Arg.Any<string?>(), Arg.Any<bool>(), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task AllowOkOutcomeResolvesAuthoritativelyWithTheConfiguredChannelAsModerator()
  {
    var (client, store, helix) = BuildOperatorClient();
    var pending = BuildHold();
    _ = store.GetHoldAsync("held-1", Arg.Any<CancellationToken>()).Returns(pending);
    _ = helix.ResolveAutomodMessageAsync("held-1", true, Arg.Any<CancellationToken>())
      .Returns(Result.Ok(new AutomodResolution { Outcome = AutomodOutcomes.Ok }));
    var resolved = pending with { ResolvedAt = DateTimeOffset.UtcNow, Resolution = "allowed", ResolvedBy = "codeacula" };
    _ = store.ResolveHoldAsync("held-1", "allowed", "codeacula", true, Arg.Any<CancellationToken>())
      .Returns(new AutomodResolveResult(resolved, true));

    var response = await client.PostAsync("/api/automod/held-1/allow", null);

    Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    var body = await response.Content.ReadAsStringAsync();
    Assert.Contains("\"resolution\":\"allowed\"", body);
    _ = await store.Received(1).ResolveHoldAsync("held-1", "allowed", "codeacula", true, Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task DenyGoneOutcomeResolvesAsExpiredNonAuthoritatively()
  {
    var (client, store, helix) = BuildOperatorClient();
    var pending = BuildHold();
    _ = store.GetHoldAsync("held-1", Arg.Any<CancellationToken>()).Returns(pending);
    _ = helix.ResolveAutomodMessageAsync("held-1", false, Arg.Any<CancellationToken>())
      .Returns(Result.Ok(new AutomodResolution { Outcome = AutomodOutcomes.Gone }));
    var resolved = pending with { ResolvedAt = DateTimeOffset.UtcNow, Resolution = "expired" };
    _ = store.ResolveHoldAsync("held-1", "expired", null, false, Arg.Any<CancellationToken>())
      .Returns(new AutomodResolveResult(resolved, true));

    var response = await client.PostAsync("/api/automod/held-1/deny", null);

    Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    var body = await response.Content.ReadAsStringAsync();
    Assert.Contains("\"resolution\":\"expired\"", body);
    _ = await store.Received(1).ResolveHoldAsync("held-1", "expired", null, false, Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task AllowIsForbiddenWithAnOverlayTokenAndNeverTouchesTheStoreOrHelix()
  {
    var (client, store, helix) = BuildOperatorClient();
    var overlay = OverlayToken.Derive(OperatorToken);
    client.DefaultRequestHeaders.Authorization = null;

    var response = await client.PostAsync($"/api/automod/held-1/allow?token={overlay}", null);

    Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    _ = await store.DidNotReceive().GetHoldAsync(Arg.Any<string>(), Arg.Any<CancellationToken>());
    _ = await helix.DidNotReceive().ResolveAutomodMessageAsync(Arg.Any<string>(), Arg.Any<bool>(), Arg.Any<CancellationToken>());
  }
}
