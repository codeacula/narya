using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;

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

namespace Narya.Api.Tests.Controllers;

/// <summary>
/// Exercises <c>/api/media-assets</c> and <c>/api/media/discovered</c> through a real host under
/// <c>Narya:SkipInfrastructure=true</c>. <see cref="IMediaAssetStore"/> is substituted with a
/// controlled instance (via <c>ConfigureTestServices</c>) — <c>AddNaryaDatabase</c> (which
/// normally registers it) never runs under the infrastructure guard.
/// <see cref="IMediaFileCatalog"/> is deliberately NOT substituted anywhere in this class except
/// where a test needs a controlled <c>Discovered()</c> result: its <c>NullMediaFileCatalog</c>
/// default (registered via <c>TryAddSingleton</c> in <c>AddNaryaApplication</c>) is enough to
/// satisfy DI for every other test. <see cref="IAppConfigStore"/>/<see cref="IStreamSessionStore"/>/
/// <see cref="IChatStore"/>/<see cref="IStreamEventStore"/>/<see cref="IViewerStore"/>/
/// <see cref="IAutomodStore"/> are also substituted (unconfigured — nothing here exercises them),
/// same reason as <c>ConfigControllerTests</c>. Every route is operator-only — deliberately NOT
/// on <c>DashboardTokenMiddleware.OverlayPaths</c> — so the overlay-token case asserts 403,
/// mirroring <c>AutomodControllerTests</c>.
/// </summary>
public sealed class MediaAssetsControllerTests
{
  private const string OperatorToken = "op-token";

  private static (HttpClient Client, IMediaAssetStore Store, IMediaFileCatalog Catalog) BuildOperatorClient()
  {
    var store = Substitute.For<IMediaAssetStore>();
    var catalog = Substitute.For<IMediaFileCatalog>();

    var client = new WebApplicationFactory<Program>()
      .WithWebHostBuilder(b =>
      {
        _ = b.UseSetting("Narya:DashboardToken", OperatorToken);
        _ = b.UseSetting("Narya:SkipInfrastructure", "true");

        _ = b.ConfigureTestServices(services =>
        {
          _ = services.AddSingleton(store);
          _ = services.AddSingleton(catalog);
          _ = services.AddSingleton(Substitute.For<IAppConfigStore>());
          _ = services.AddSingleton(Substitute.For<IStreamSessionStore>());
          _ = services.AddSingleton(Substitute.For<IChatStore>());
          _ = services.AddSingleton(Substitute.For<IStreamEventStore>());
          _ = services.AddSingleton(Substitute.For<IViewerStore>());
          _ = services.AddSingleton(Substitute.For<IAutomodStore>());
          _ = services.AddSingleton(Substitute.For<IActionStore>());
          _ = services.AddSingleton(Substitute.For<IMediaResolver>());
          _ = services.AddSingleton(Substitute.For<IHelixClient>());
          _ = services.AddSingleton(Substitute.For<IMediaMuteStore>());
          _ = services.AddSingleton(Substitute.For<IAutomationTriggerStore>());
          _ = services.AddSingleton(Substitute.For<IAutomationRunStore>());
        });
      })
      .CreateClient();

    client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", OperatorToken);
    return (client, store, catalog);
  }

  private static MediaAsset BuildAsset(
    Guid? id = null,
    string label = "Air Horn",
    MediaKind kind = MediaKind.Audio,
    MediaSourceType sourceType = MediaSourceType.Remote,
    string src = "https://example.com/air-horn.mp3",
    bool enabled = true,
    bool available = true) => new(
      Id: id ?? Guid.NewGuid(),
      Label: label,
      Kind: kind,
      SourceType: sourceType,
      Src: src,
      Volume: 0.8,
      Enabled: enabled,
      Available: available,
      CreatedAt: DateTimeOffset.UtcNow,
      UpdatedAt: DateTimeOffset.UtcNow);

  // ---------------------------------------------------------------------------------------
  // GET /api/media-assets
  // ---------------------------------------------------------------------------------------

  [Fact]
  public async Task GetAllReturnsTheStoresAssets()
  {
    var (client, store, _) = BuildOperatorClient();
    var asset = BuildAsset();
    _ = store.GetAllAsync(Arg.Any<CancellationToken>()).Returns([asset]);

    var response = await client.GetAsync("/api/media-assets");

    Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    var body = await response.Content.ReadAsStringAsync();
    Assert.Contains("\"label\":\"Air Horn\"", body);
    Assert.Contains("\"kind\":\"audio\"", body);
    Assert.Contains("\"sourceType\":\"remote\"", body);
  }

  [Fact]
  public async Task GetAllIsForbiddenWithAnOverlayToken()
  {
    var (client, store, _) = BuildOperatorClient();
    var overlay = OverlayToken.Derive(OperatorToken);
    client.DefaultRequestHeaders.Authorization = null;

    var response = await client.GetAsync($"/api/media-assets?token={overlay}");

    Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    _ = await store.DidNotReceive().GetAllAsync(Arg.Any<CancellationToken>());
  }

  // ---------------------------------------------------------------------------------------
  // POST /api/media-assets
  // ---------------------------------------------------------------------------------------

  [Fact]
  public async Task CreateSuccessReturns201WithTheCreatedAsset()
  {
    var (client, store, _) = BuildOperatorClient();
    var created = BuildAsset();
    _ = store.CreateAsync(Arg.Any<MediaAssetPatch>(), Arg.Any<CancellationToken>()).Returns(Result.Ok(created));

    var response = await client.PostAsJsonAsync(
      "/api/media-assets",
      new { label = "Air Horn", kind = "audio", sourceType = "remote", src = "https://example.com/air-horn.mp3" });

    Assert.Equal(HttpStatusCode.Created, response.StatusCode);
    var body = await response.Content.ReadAsStringAsync();
    Assert.Contains("\"label\":\"Air Horn\"", body);
  }

  [Fact]
  public async Task CreateValidationFailureReturns400WithTheErrorMessage()
  {
    var (client, store, _) = BuildOperatorClient();
    _ = store.CreateAsync(Arg.Any<MediaAssetPatch>(), Arg.Any<CancellationToken>())
      .Returns(Result.Fail<MediaAsset>("A label is required."));

    var response = await client.PostAsJsonAsync("/api/media-assets", new { });

    Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    var body = await response.Content.ReadAsStringAsync();
    Assert.Contains("A label is required.", body);
  }

  [Fact]
  public async Task CreateBindsTheEnumFieldsFromLowercaseJsonStrings()
  {
    var (client, store, _) = BuildOperatorClient();
    _ = store.CreateAsync(Arg.Any<MediaAssetPatch>(), Arg.Any<CancellationToken>())
      .Returns(callInfo => Result.Ok(BuildAsset(
        kind: callInfo.Arg<MediaAssetPatch>().Kind!.Value,
        sourceType: callInfo.Arg<MediaAssetPatch>().SourceType!.Value)));

    var response = await client.PostAsJsonAsync(
      "/api/media-assets",
      new { label = "Win", kind = "video", sourceType = "local", src = "/clips/win.mp4" });

    Assert.Equal(HttpStatusCode.Created, response.StatusCode);
    _ = await store.Received(1).CreateAsync(
      Arg.Is<MediaAssetPatch>(p => p.Kind == MediaKind.Video && p.SourceType == MediaSourceType.Local),
      Arg.Any<CancellationToken>());
  }

  // ---------------------------------------------------------------------------------------
  // PUT /api/media-assets/{id}
  // ---------------------------------------------------------------------------------------

  [Fact]
  public async Task UpdateUnknownIdReturns404()
  {
    var (client, store, _) = BuildOperatorClient();
    var id = Guid.NewGuid();
    _ = store.UpdateAsync(id, Arg.Any<MediaAssetPatch>(), Arg.Any<CancellationToken>())
      .Returns((Result<MediaAsset>?)null);

    var response = await client.PutAsJsonAsync($"/api/media-assets/{id}", new { label = "New" });

    Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
  }

  [Fact]
  public async Task UpdateValidationFailureReturns400()
  {
    var (client, store, _) = BuildOperatorClient();
    var id = Guid.NewGuid();
    _ = store.UpdateAsync(id, Arg.Any<MediaAssetPatch>(), Arg.Any<CancellationToken>())
      .Returns(Result.Fail<MediaAsset>("A label is required."));

    var response = await client.PutAsJsonAsync($"/api/media-assets/{id}", new { label = "   " });

    Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
  }

  [Fact]
  public async Task UpdateSuccessReturns200WithTheUpdatedAsset()
  {
    var (client, store, _) = BuildOperatorClient();
    var id = Guid.NewGuid();
    var updated = BuildAsset(id: id, label: "Renamed");
    _ = store.UpdateAsync(id, Arg.Any<MediaAssetPatch>(), Arg.Any<CancellationToken>())
      .Returns(Result.Ok(updated));

    var response = await client.PutAsJsonAsync($"/api/media-assets/{id}", new { label = "Renamed" });

    Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    var body = await response.Content.ReadAsStringAsync();
    Assert.Contains("\"label\":\"Renamed\"", body);
  }

  // ---------------------------------------------------------------------------------------
  // DELETE /api/media-assets/{id}
  // ---------------------------------------------------------------------------------------

  [Fact]
  public async Task DeleteUnknownIdReturns404()
  {
    var (client, store, _) = BuildOperatorClient();
    var id = Guid.NewGuid();
    _ = store.DeleteAsync(id, Arg.Any<CancellationToken>()).Returns(MediaAssetDeleteOutcome.NotFound);

    var response = await client.DeleteAsync($"/api/media-assets/{id}");

    Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
  }

  [Fact]
  public async Task DeleteReferencedAssetReturns409()
  {
    var (client, store, _) = BuildOperatorClient();
    var id = Guid.NewGuid();
    _ = store.DeleteAsync(id, Arg.Any<CancellationToken>()).Returns(MediaAssetDeleteOutcome.Referenced);

    var response = await client.DeleteAsync($"/api/media-assets/{id}");

    Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
    var body = await response.Content.ReadAsStringAsync();
    Assert.Contains("used by an Action", body);
  }

  [Fact]
  public async Task DeleteUnreferencedAssetReturns204()
  {
    var (client, store, _) = BuildOperatorClient();
    var id = Guid.NewGuid();
    _ = store.DeleteAsync(id, Arg.Any<CancellationToken>()).Returns(MediaAssetDeleteOutcome.Deleted);

    var response = await client.DeleteAsync($"/api/media-assets/{id}");

    Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
  }

  // ---------------------------------------------------------------------------------------
  // GET /api/media/discovered
  // ---------------------------------------------------------------------------------------

  [Fact]
  public async Task DiscoveredReturnsCatalogFilesAndConfiguredLocalSrcsFromTheStore()
  {
    var (client, store, catalog) = BuildOperatorClient();
    _ = store.GetAllAsync(Arg.Any<CancellationToken>()).Returns([
      BuildAsset(sourceType: MediaSourceType.Local, src: "/sounds/quack.mp3"),
      BuildAsset(sourceType: MediaSourceType.Remote, src: "https://example.com/air-horn.mp3"),
    ]);
    _ = catalog.Discovered().Returns([new MediaFile("/sounds/quack.mp3", "quack", MediaKind.Audio, 1024)]);

    var response = await client.GetAsync("/api/media/discovered");

    Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    var body = await response.Content.ReadAsStringAsync();
    Assert.Contains("\"src\":\"/sounds/quack.mp3\"", body);
    Assert.Contains("\"configuredSrcs\":[\"/sounds/quack.mp3\"]", body);
    Assert.DoesNotContain("https://example.com/air-horn.mp3", body); // remote srcs never appear in configuredSrcs
  }

  [Fact]
  public async Task DiscoveredIsForbiddenWithAnOverlayToken()
  {
    var (client, store, catalog) = BuildOperatorClient();
    var overlay = OverlayToken.Derive(OperatorToken);
    client.DefaultRequestHeaders.Authorization = null;

    var response = await client.GetAsync($"/api/media/discovered?token={overlay}");

    Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    _ = await store.DidNotReceive().GetAllAsync(Arg.Any<CancellationToken>());
    _ = catalog.DidNotReceive().Discovered();
  }
}
