using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;

using FluentResults;

using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;

using NSubstitute;

using Narya.Api.Auth;
using Narya.Core.AppConfig;
using Narya.Core.Sessions;

using DomainConfig = Narya.Domain.AppConfig.AppConfig;

namespace Narya.Api.Tests.Controllers;

/// <summary>
/// Exercises <c>/api/config</c> end to end through the real MediatR pipeline (real
/// <c>UpdateAppConfigCommandValidator</c> included) — only <see cref="IAppConfigStore"/>
/// is substituted, via <c>ConfigureTestServices</c>, since <c>AddNaryaDatabase</c> (which
/// normally registers it) is skipped under <c>Narya:SkipInfrastructure=true</c>. This
/// proves the controller's <c>Result</c>→HTTP mapping AND that the real validator bounds
/// (see <c>UpdateAppConfigCommandValidator</c>) are what reject an out-of-range PUT, not a
/// hand-rolled stand-in for it. <see cref="IStreamSessionStore"/> is also substituted
/// (unconfigured — nothing here exercises it) purely to satisfy DI validation: the Sessions
/// handlers registered by MediatR's assembly scan take a constructor dependency on it, and
/// <c>AddNaryaDatabase</c> is skipped just like it is for <see cref="IAppConfigStore"/>.
/// </summary>
public sealed class ConfigControllerTests
{
  private const string OperatorToken = "op-token";

  private static HttpClient BuildOperatorClient(IAppConfigStore store)
  {
    var client = new WebApplicationFactory<Program>()
      .WithWebHostBuilder(b =>
      {
        // UseSetting (not ConfigureAppConfiguration+AddInMemoryCollection) — see the
        // comment in DashboardTokenMiddlewareTests.BuildClient for why: Program.cs reads
        // Narya:SkipInfrastructure in top-level code before ConfigureAppConfiguration
        // sources are visible, but UseSetting is visible at that read.
        _ = b.UseSetting("Narya:DashboardToken", OperatorToken);
        _ = b.UseSetting("Narya:SkipInfrastructure", "true");

        _ = b.ConfigureTestServices(services =>
        {
          _ = services.AddSingleton(store);
          _ = services.AddSingleton(Substitute.For<IStreamSessionStore>());
        });
      })
      .CreateClient();

    client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", OperatorToken);
    return client;
  }

  [Fact]
  public async Task GetReturnsMaskedConfigForOperator()
  {
    var store = Substitute.For<IAppConfigStore>();
    _ = store.GetAsync(Arg.Any<CancellationToken>())
      .Returns(Result.Ok(new DomainConfig { TwitchChannel = "codeacula", TwitchClientSecret = "s3cret" }));
    var client = BuildOperatorClient(store);

    var response = await client.GetAsync("/api/config");

    Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    var body = await response.Content.ReadAsStringAsync();
    Assert.Contains("twitchClientSecretConfigured", body);
    Assert.DoesNotContain("s3cret", body);
  }

  [Fact]
  public async Task PutWithSoundVolumeAboveOneReturns400()
  {
    var store = Substitute.For<IAppConfigStore>();
    _ = store.UpdateAsync(Arg.Any<AppConfigPatch>(), Arg.Any<CancellationToken>())
      .Returns(Result.Ok(new DomainConfig()));
    var client = BuildOperatorClient(store);

    var response = await client.PutAsJsonAsync("/api/config", new { soundVolume = 1.5 });

    Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    var body = await response.Content.ReadAsStringAsync();
    Assert.Contains("errors", body);
    _ = await store.DidNotReceive().UpdateAsync(Arg.Any<AppConfigPatch>(), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task PutWithNegativeMusicPollIntervalReturns400()
  {
    var store = Substitute.For<IAppConfigStore>();
    _ = store.UpdateAsync(Arg.Any<AppConfigPatch>(), Arg.Any<CancellationToken>())
      .Returns(Result.Ok(new DomainConfig()));
    var client = BuildOperatorClient(store);

    var response = await client.PutAsJsonAsync("/api/config", new { musicPollIntervalMs = -1 });

    Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    _ = await store.DidNotReceive().UpdateAsync(Arg.Any<AppConfigPatch>(), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task PutWithValidChannelReturns200WithUpdatedChannel()
  {
    var store = Substitute.For<IAppConfigStore>();
    _ = store.UpdateAsync(Arg.Any<AppConfigPatch>(), Arg.Any<CancellationToken>())
      .Returns(callInfo => Result.Ok(new DomainConfig { TwitchChannel = callInfo.Arg<AppConfigPatch>().TwitchChannel ?? "" }));
    var client = BuildOperatorClient(store);

    var response = await client.PutAsJsonAsync("/api/config", new { twitchChannel = "codeacula" });

    Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    var body = await response.Content.ReadAsStringAsync();
    Assert.Contains("\"twitchChannel\":\"codeacula\"", body);
  }

  [Fact]
  public async Task GetWithOverlayTokenIsForbidden()
  {
    var store = Substitute.For<IAppConfigStore>();
    var client = BuildOperatorClient(store);
    var overlay = OverlayToken.Derive(OperatorToken);

    // Deliberately no Authorization header — an overlay caller uses the query-string
    // token, mirroring how an OBS browser source is configured.
    client.DefaultRequestHeaders.Authorization = null;
    var response = await client.GetAsync($"/api/config?token={overlay}");

    Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    _ = await store.DidNotReceive().GetAsync(Arg.Any<CancellationToken>());
  }
}
