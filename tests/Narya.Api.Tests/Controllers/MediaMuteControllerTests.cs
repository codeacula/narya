using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;

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
/// Exercises <c>/api/automation/media-mute</c> through a real host under
/// <c>Narya:SkipInfrastructure=true</c> — same shape as <c>MediaAssetsControllerTests</c>.
/// <see cref="IMediaMuteStore"/> is substituted with a controlled instance (via
/// <c>ConfigureTestServices</c>) — <c>AddNaryaDatabase</c> (which normally registers it, and the
/// <c>IMediaMuteGate</c> override alongside it in <c>Program.cs</c>) never runs under the
/// infrastructure guard. Every other document store is substituted unconfigured, same reason as
/// <c>MediaAssetsControllerTests</c> (ValidateOnBuild eagerly constructs every MediatR handler in
/// the DI graph regardless of which controller a given test targets — including
/// <c>GetMediaMuteQueryHandler</c>/<c>SetMediaMuteCommandHandler</c> themselves, which is exactly
/// why every OTHER controller test class in this assembly also needed an <see cref="IMediaMuteStore"/>
/// substitute added once this class's handlers existed). The route is operator-only — deliberately
/// NOT on <c>DashboardTokenMiddleware.OverlayPaths</c> — so the overlay-token case asserts 403,
/// mirroring <c>MediaAssetsControllerTests</c>.
/// </summary>
public sealed class MediaMuteControllerTests
{
  private const string OperatorToken = "op-token";

  private static (HttpClient Client, IMediaMuteStore Store) BuildOperatorClient()
  {
    var store = Substitute.For<IMediaMuteStore>();

    var client = new WebApplicationFactory<Program>()
      .WithWebHostBuilder(b =>
      {
        _ = b.UseSetting("Narya:DashboardToken", OperatorToken);
        _ = b.UseSetting("Narya:SkipInfrastructure", "true");

        _ = b.ConfigureTestServices(services =>
        {
          _ = services.AddSingleton(store);
          _ = services.AddSingleton(Substitute.For<IAppConfigStore>());
          _ = services.AddSingleton(Substitute.For<IStreamSessionStore>());
          _ = services.AddSingleton(Substitute.For<IChatStore>());
          _ = services.AddSingleton(Substitute.For<IStreamEventStore>());
          _ = services.AddSingleton(Substitute.For<IViewerStore>());
          _ = services.AddSingleton(Substitute.For<IAutomodStore>());
          _ = services.AddSingleton(Substitute.For<IMediaAssetStore>());
          _ = services.AddSingleton(Substitute.For<IActionStore>());
          _ = services.AddSingleton(Substitute.For<IMediaResolver>());
          _ = services.AddSingleton(Substitute.For<IHelixClient>());
          _ = services.AddSingleton(Substitute.For<IAutomationTriggerStore>());
          _ = services.AddSingleton(Substitute.For<IAutomationRunStore>());
        });
      })
      .CreateClient();

    client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", OperatorToken);
    return (client, store);
  }

  // ---------------------------------------------------------------------------------------
  // GET /api/automation/media-mute
  // ---------------------------------------------------------------------------------------

  [Fact]
  public async Task GetReturnsTheStoresMutedState()
  {
    var (client, store) = BuildOperatorClient();
    _ = store.GetMutedAsync(Arg.Any<CancellationToken>()).Returns(true);

    var response = await client.GetAsync("/api/automation/media-mute");

    Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    var body = await response.Content.ReadAsStringAsync();
    Assert.Contains("\"muted\":true", body);
  }

  [Fact]
  public async Task GetIsForbiddenWithAnOverlayToken()
  {
    var (client, store) = BuildOperatorClient();
    var overlay = OverlayToken.Derive(OperatorToken);
    client.DefaultRequestHeaders.Authorization = null;

    var response = await client.GetAsync($"/api/automation/media-mute?token={overlay}");

    Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    _ = await store.DidNotReceive().GetMutedAsync(Arg.Any<CancellationToken>());
  }

  // ---------------------------------------------------------------------------------------
  // PUT /api/automation/media-mute — strict body.muted === true coercion
  // ---------------------------------------------------------------------------------------

  [Fact]
  public async Task PutWithLiteralTrueMutes()
  {
    var (client, store) = BuildOperatorClient();
    _ = store.SetMutedAsync(true, Arg.Any<CancellationToken>()).Returns(new MediaMuteState(true));

    var response = await client.PutAsJsonAsync("/api/automation/media-mute", new { muted = true });

    Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    var body = await response.Content.ReadAsStringAsync();
    Assert.Contains("\"muted\":true", body);
    _ = await store.Received(1).SetMutedAsync(true, Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task PutWithStringTrueCoercesToFalse()
  {
    var (client, store) = BuildOperatorClient();
    _ = store.SetMutedAsync(false, Arg.Any<CancellationToken>()).Returns(new MediaMuteState(false));

    var response = await client.PutAsJsonAsync("/api/automation/media-mute", new { muted = "true" });

    Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    var body = await response.Content.ReadAsStringAsync();
    Assert.Contains("\"muted\":false", body);
    _ = await store.Received(1).SetMutedAsync(false, Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task PutWithNumericOneCoercesToFalse()
  {
    var (client, store) = BuildOperatorClient();
    _ = store.SetMutedAsync(false, Arg.Any<CancellationToken>()).Returns(new MediaMuteState(false));

    var response = await client.PutAsJsonAsync("/api/automation/media-mute", new { muted = 1 });

    Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    var body = await response.Content.ReadAsStringAsync();
    Assert.Contains("\"muted\":false", body);
    _ = await store.Received(1).SetMutedAsync(false, Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task PutWithEmptyBodyCoercesToFalse()
  {
    var (client, store) = BuildOperatorClient();
    _ = store.SetMutedAsync(false, Arg.Any<CancellationToken>()).Returns(new MediaMuteState(false));

    var response = await client.PutAsync(
      "/api/automation/media-mute",
      new StringContent("{}", Encoding.UTF8, "application/json"));

    Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    var body = await response.Content.ReadAsStringAsync();
    Assert.Contains("\"muted\":false", body);
    _ = await store.Received(1).SetMutedAsync(false, Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task PutWithNoBodyAtAllCoercesToFalse()
  {
    var (client, store) = BuildOperatorClient();
    _ = store.SetMutedAsync(false, Arg.Any<CancellationToken>()).Returns(new MediaMuteState(false));

    var response = await client.PutAsync(
      "/api/automation/media-mute",
      new StringContent(string.Empty, Encoding.UTF8, "application/json"));

    Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    var body = await response.Content.ReadAsStringAsync();
    Assert.Contains("\"muted\":false", body);
    _ = await store.Received(1).SetMutedAsync(false, Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task PutIsForbiddenWithAnOverlayToken()
  {
    var (client, store) = BuildOperatorClient();
    var overlay = OverlayToken.Derive(OperatorToken);
    client.DefaultRequestHeaders.Authorization = null;

    var response = await client.PutAsync(
      $"/api/automation/media-mute?token={overlay}",
      new StringContent("{\"muted\":true}", Encoding.UTF8, "application/json"));

    Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    _ = await store.DidNotReceive().SetMutedAsync(Arg.Any<bool>(), Arg.Any<CancellationToken>());
  }
}
