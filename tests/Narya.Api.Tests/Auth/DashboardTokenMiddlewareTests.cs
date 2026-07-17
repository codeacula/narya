using System.Net;
using System.Net.Http.Headers;

using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;

namespace Narya.Api.Tests.Auth;

public sealed class DashboardTokenMiddlewareTests
{
  private static HttpClient BuildClient(string configuredToken) =>
    new WebApplicationFactory<Program>()
      .WithWebHostBuilder(b => b.ConfigureAppConfiguration((_, cfg) =>
        cfg.AddInMemoryCollection(new Dictionary<string, string?>
        {
          ["Narya:DashboardToken"] = configuredToken,
          ["Narya:SkipInfrastructure"] = "true", // Program.cs guard: no Marten/Redis in these tests
        })))
      .CreateClient();

  [Fact]
  public async Task MissingTokenIs401WithCode()
  {
    var response = await BuildClient("op-token").GetAsync("/api/health");
    Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    Assert.Contains("INVALID_DASHBOARD_TOKEN", await response.Content.ReadAsStringAsync());
  }

  [Fact]
  public async Task OperatorBearerTokenPasses()
  {
    var client = BuildClient("op-token");
    client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", "op-token");
    var response = await client.GetAsync("/api/health");
    Assert.Equal(HttpStatusCode.OK, response.StatusCode);
  }

  [Fact]
  public async Task OperatorXDashboardTokenHeaderPasses()
  {
    var client = BuildClient("op-token");
    client.DefaultRequestHeaders.Add("X-Dashboard-Token", "op-token");
    var response = await client.GetAsync("/api/health");
    Assert.Equal(HttpStatusCode.OK, response.StatusCode);
  }

  [Fact]
  public async Task WrongTokenIs401WithCode()
  {
    var client = BuildClient("op-token");
    client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", "not-the-token");
    var response = await client.GetAsync("/api/health");
    Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    Assert.Contains("INVALID_DASHBOARD_TOKEN", await response.Content.ReadAsStringAsync());
  }

  [Fact]
  public async Task OverlayTokenReachesAllowlistedGetOnly()
  {
    var overlay = Narya.Api.Auth.OverlayToken.Derive("op-token");
    var client = BuildClient("op-token");
    var ok = await client.GetAsync($"/api/health?token={overlay}");
    Assert.Equal(HttpStatusCode.OK, ok.StatusCode);

    // /api/config isn't guaranteed to exist yet under SkipInfrastructure (Task 10
    // ships it) — the point being proven is that the middleware itself rejects an
    // overlay token on a non-allowlisted path before any endpoint runs, so a
    // non-existent-but-non-allowlisted route works just as well as a real one.
    var forbidden = await client.GetAsync($"/api/config?token={overlay}");
    Assert.Equal(HttpStatusCode.Forbidden, forbidden.StatusCode);
  }

  [Fact]
  public async Task OverlayTokenRejectedOnOverlayTokenEndpoint()
  {
    var overlay = Narya.Api.Auth.OverlayToken.Derive("op-token");
    var client = BuildClient("op-token");
    var response = await client.GetAsync($"/api/auth/overlay-token?token={overlay}");
    Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
  }

  [Fact]
  public async Task OperatorCanFetchOverlayTokenEndpoint()
  {
    var client = BuildClient("op-token");
    client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", "op-token");
    var response = await client.GetAsync("/api/auth/overlay-token");
    Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    var body = await response.Content.ReadAsStringAsync();
    Assert.Contains(Narya.Api.Auth.OverlayToken.Derive("op-token"), body);
  }

  [Fact]
  public async Task NoTokenConfiguredOverlayTokenEndpointIs404()
  {
    var client = BuildClient(string.Empty);
    var response = await client.GetAsync("/api/auth/overlay-token");
    Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
  }
}
