using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;

using FluentResults;

using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;

using NSubstitute;

using Narya.Api.Auth;
using Narya.Core.Actions;
using Narya.Core.AppConfig;
using Narya.Core.Automod;
using Narya.Core.Chat;
using Narya.Core.Events;
using Narya.Core.Media;
using Narya.Core.Sessions;
using Narya.Core.Viewers;

namespace Narya.Api.Tests.Controllers;

/// <summary>
/// Exercises <c>/api/actions</c> through a real host under <c>Narya:SkipInfrastructure=true</c> —
/// same shape as <c>MediaAssetsControllerTests</c>. <see cref="IActionStore"/> is substituted with
/// a controlled instance; every other document store is substituted unconfigured, same reason as
/// <c>MediaAssetsControllerTests</c> (ValidateOnBuild eagerly constructs every MediatR handler in
/// the DI graph regardless of which controller a given test targets). Every route is
/// operator-only — deliberately NOT on <c>DashboardTokenMiddleware.OverlayPaths</c>.
/// </summary>
public sealed class ActionsControllerTests
{
  private const string OperatorToken = "op-token";

  private static (HttpClient Client, IActionStore Store) BuildOperatorClient()
  {
    var store = Substitute.For<IActionStore>();

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
        });
      })
      .CreateClient();

    client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", OperatorToken);
    return (client, store);
  }

  private static AutomationAction BuildAction(
    Guid? id = null,
    string name = "Hype Train",
    bool enabled = true,
    bool quickDisable = false,
    IReadOnlyList<ActionStep>? steps = null) => new(
      Id: id ?? Guid.NewGuid(),
      Name: name,
      Description: "Plays a clip.",
      Enabled: enabled,
      QuickDisable: quickDisable,
      Steps: steps ?? [new ObsTransitionActionStep { Id = Guid.NewGuid(), Position = 0 }],
      CreatedAt: DateTimeOffset.UtcNow,
      UpdatedAt: DateTimeOffset.UtcNow);

  // ---------------------------------------------------------------------------------------
  // GET /api/actions
  // ---------------------------------------------------------------------------------------

  [Fact]
  public async Task GetAllReturnsABareArrayOfTheStoresActions()
  {
    var (client, store) = BuildOperatorClient();
    var action = BuildAction();
    _ = store.GetAllAsync(Arg.Any<CancellationToken>()).Returns([action]);

    var response = await client.GetAsync("/api/actions");

    Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    var body = await response.Content.ReadAsStringAsync();
    Assert.StartsWith("[", body, StringComparison.Ordinal);
    Assert.Contains("\"name\":\"Hype Train\"", body);
  }

  [Fact]
  public async Task GetAllIsForbiddenWithAnOverlayToken()
  {
    var (client, store) = BuildOperatorClient();
    var overlay = OverlayToken.Derive(OperatorToken);
    client.DefaultRequestHeaders.Authorization = null;

    var response = await client.GetAsync($"/api/actions?token={overlay}");

    Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    _ = await store.DidNotReceive().GetAllAsync(Arg.Any<CancellationToken>());
  }

  // ---------------------------------------------------------------------------------------
  // POST /api/actions
  // ---------------------------------------------------------------------------------------

  [Fact]
  public async Task CreateSuccessReturns201WithTheCreatedAction()
  {
    var (client, store) = BuildOperatorClient();
    var created = BuildAction();
    _ = store.CreateAsync(Arg.Any<ActionUpsert>(), Arg.Any<CancellationToken>()).Returns(Result.Ok(created));

    var response = await client.PostAsJsonAsync(
      "/api/actions",
      new { name = "Hype Train", steps = new[] { new { type = "obs_transition" } } });

    Assert.Equal(HttpStatusCode.Created, response.StatusCode);
    var body = await response.Content.ReadAsStringAsync();
    Assert.Contains("\"name\":\"Hype Train\"", body);
  }

  [Fact]
  public async Task CreateValidationFailureReturns400WithTheErrorMessage()
  {
    var (client, store) = BuildOperatorClient();
    _ = store.CreateAsync(Arg.Any<ActionUpsert>(), Arg.Any<CancellationToken>())
      .Returns(Result.Fail<AutomationAction>("At least one step is required."));

    var response = await client.PostAsJsonAsync("/api/actions", new { name = "Hype Train", steps = Array.Empty<object>() });

    Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    var body = await response.Content.ReadAsStringAsync();
    Assert.Contains("At least one step is required.", body);
  }

  [Fact]
  public async Task CreateDuplicateNameReturns409()
  {
    var (client, store) = BuildOperatorClient();
    _ = store.CreateAsync(Arg.Any<ActionUpsert>(), Arg.Any<CancellationToken>())
      .Returns(Result.Fail<AutomationAction>(new DuplicateActionNameError("Hype Train")));

    var response = await client.PostAsJsonAsync(
      "/api/actions",
      new { name = "Hype Train", steps = new[] { new { type = "obs_transition" } } });

    Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
    var body = await response.Content.ReadAsStringAsync();
    Assert.Contains("already exists", body);
  }

  // ---------------------------------------------------------------------------------------
  // PUT /api/actions/{id}
  // ---------------------------------------------------------------------------------------

  [Fact]
  public async Task UpdateUnknownIdReturns404()
  {
    var (client, store) = BuildOperatorClient();
    var id = Guid.NewGuid();
    _ = store.UpdateAsync(id, Arg.Any<ActionUpsert>(), Arg.Any<CancellationToken>())
      .Returns((Result<AutomationAction>?)null);

    var response = await client.PutAsJsonAsync($"/api/actions/{id}", new { name = "New" });

    Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
  }

  [Fact]
  public async Task UpdateValidationFailureReturns400()
  {
    var (client, store) = BuildOperatorClient();
    var id = Guid.NewGuid();
    _ = store.UpdateAsync(id, Arg.Any<ActionUpsert>(), Arg.Any<CancellationToken>())
      .Returns(Result.Fail<AutomationAction>("Action name is required."));

    var response = await client.PutAsJsonAsync($"/api/actions/{id}", new { name = "   " });

    Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
  }

  [Fact]
  public async Task UpdateDuplicateNameReturns409()
  {
    var (client, store) = BuildOperatorClient();
    var id = Guid.NewGuid();
    _ = store.UpdateAsync(id, Arg.Any<ActionUpsert>(), Arg.Any<CancellationToken>())
      .Returns(Result.Fail<AutomationAction>(new DuplicateActionNameError("Taken")));

    var response = await client.PutAsJsonAsync($"/api/actions/{id}", new { name = "Taken" });

    Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
  }

  [Fact]
  public async Task UpdateSuccessReturns200WithTheUpdatedAction()
  {
    var (client, store) = BuildOperatorClient();
    var id = Guid.NewGuid();
    var updated = BuildAction(id: id, name: "Renamed");
    _ = store.UpdateAsync(id, Arg.Any<ActionUpsert>(), Arg.Any<CancellationToken>()).Returns(Result.Ok(updated));

    var response = await client.PutAsJsonAsync($"/api/actions/{id}", new { name = "Renamed" });

    Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    var body = await response.Content.ReadAsStringAsync();
    Assert.Contains("\"name\":\"Renamed\"", body);
  }

  // ---------------------------------------------------------------------------------------
  // DELETE /api/actions/{id}
  // ---------------------------------------------------------------------------------------

  [Fact]
  public async Task DeleteUnknownIdReturns404()
  {
    var (client, store) = BuildOperatorClient();
    var id = Guid.NewGuid();
    _ = store.DeleteAsync(id, Arg.Any<CancellationToken>()).Returns(false);

    var response = await client.DeleteAsync($"/api/actions/{id}");

    Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
  }

  [Fact]
  public async Task DeleteKnownIdReturns204()
  {
    var (client, store) = BuildOperatorClient();
    var id = Guid.NewGuid();
    _ = store.DeleteAsync(id, Arg.Any<CancellationToken>()).Returns(true);

    var response = await client.DeleteAsync($"/api/actions/{id}");

    Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
  }

  // ---------------------------------------------------------------------------------------
  // POST /api/actions/{id}/run — wired in Phase 4 Task 3; for now, 404 or 501
  // ---------------------------------------------------------------------------------------

  [Fact]
  public async Task RunUnknownActionReturns404()
  {
    var (client, store) = BuildOperatorClient();
    var id = Guid.NewGuid();
    _ = store.GetByIdAsync(id, Arg.Any<CancellationToken>()).Returns((AutomationAction?)null);

    var response = await client.PostAsync($"/api/actions/{id}/run", content: null);

    Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
  }

  [Fact]
  public async Task RunKnownActionReturns501NotImplemented()
  {
    var (client, store) = BuildOperatorClient();
    var id = Guid.NewGuid();
    _ = store.GetByIdAsync(id, Arg.Any<CancellationToken>()).Returns(BuildAction(id: id));

    var response = await client.PostAsync($"/api/actions/{id}/run", content: null);

    Assert.Equal(HttpStatusCode.NotImplemented, response.StatusCode);
  }
}
