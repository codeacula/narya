using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;

using FluentResults;

using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;

using Narya.Api.Auth;
using Narya.Application.Actions;
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
/// Exercises <c>/api/automation/triggers</c> through a real host under
/// <c>Narya:SkipInfrastructure=true</c> — same shape as <c>ActionsControllerTests</c>.
/// <see cref="IAutomationTriggerStore"/> is substituted with a controlled instance; every other
/// document store is substituted unconfigured, same reason as <c>ActionsControllerTests</c>
/// (<c>ValidateOnBuild</c> eagerly constructs every MediatR handler in the DI graph regardless of
/// which controller a given test targets). Every route is operator-only — deliberately NOT on
/// <c>DashboardTokenMiddleware.OverlayPaths</c>.
/// </summary>
public sealed class AutomationTriggersControllerTests
{
  private const string OperatorToken = "op-token";

  private static (HttpClient Client, IAutomationTriggerStore Store) BuildOperatorClient()
  {
    var store = Substitute.For<IAutomationTriggerStore>();

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
          _ = services.AddSingleton(Substitute.For<IMediaResolver>());
          _ = services.AddSingleton(Substitute.For<IHelixClient>());
          _ = services.AddSingleton(Substitute.For<IActionStore>());
          _ = services.AddSingleton(Substitute.For<IActionExecutor>());
          _ = services.AddSingleton(Substitute.For<IMediaMuteStore>());
        });
      })
      .CreateClient();

    client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", OperatorToken);
    return (client, store);
  }

  private static AutomationTrigger BuildTrigger(
    Guid? id = null,
    Guid? actionId = null,
    bool enabled = true,
    TriggerConfig? config = null) => new(
      Id: id ?? Guid.NewGuid(),
      Kind: AutomationTriggerKind.ChatPhrase,
      ActionId: actionId ?? Guid.NewGuid(),
      ModuleId: null,
      Enabled: enabled,
      GlobalCooldownMs: 30_000,
      UserCooldownMs: 60_000,
      Config: config ?? new ChatPhraseTriggerConfig { Phrase = "hype", Match = ChatPhraseMatch.Contains },
      CreatedAt: DateTimeOffset.UtcNow,
      UpdatedAt: DateTimeOffset.UtcNow);

  // ---------------------------------------------------------------------------------------
  // GET /api/automation/triggers
  // ---------------------------------------------------------------------------------------

  [Fact]
  public async Task GetAllReturnsABareArrayOfTheStoresTriggers()
  {
    var (client, store) = BuildOperatorClient();
    var trigger = BuildTrigger();
    _ = store.GetAllAsync(Arg.Any<CancellationToken>()).Returns([trigger]);

    var response = await client.GetAsync("/api/automation/triggers");

    Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    var body = await response.Content.ReadAsStringAsync();
    Assert.StartsWith("[", body, StringComparison.Ordinal);
    Assert.Contains("\"phrase\":\"hype\"", body);
  }

  [Fact]
  public async Task GetAllIsForbiddenWithAnOverlayToken()
  {
    var (client, store) = BuildOperatorClient();
    var overlay = OverlayToken.Derive(OperatorToken);
    client.DefaultRequestHeaders.Authorization = null;

    var response = await client.GetAsync($"/api/automation/triggers?token={overlay}");

    Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    _ = await store.DidNotReceive().GetAllAsync(Arg.Any<CancellationToken>());
  }

  // ---------------------------------------------------------------------------------------
  // POST /api/automation/triggers
  // ---------------------------------------------------------------------------------------

  [Fact]
  public async Task CreateSuccessReturns201WithTheCreatedTrigger()
  {
    var (client, store) = BuildOperatorClient();
    var created = BuildTrigger();
    _ = store.CreateAsync(Arg.Any<AutomationTriggerUpsert>(), Arg.Any<CancellationToken>()).Returns(Result.Ok(created));

    var response = await client.PostAsJsonAsync(
      "/api/automation/triggers",
      new { actionId = created.ActionId, config = new { type = "chat_phrase", phrase = "hype", match = "contains" } });

    Assert.Equal(HttpStatusCode.Created, response.StatusCode);
    var body = await response.Content.ReadAsStringAsync();
    Assert.Contains("\"phrase\":\"hype\"", body);
  }

  [Fact]
  public async Task CreateValidationFailureReturns400WithTheErrorMessage()
  {
    var (client, store) = BuildOperatorClient();
    _ = store.CreateAsync(Arg.Any<AutomationTriggerUpsert>(), Arg.Any<CancellationToken>())
      .Returns(Result.Fail<AutomationTrigger>("Action not found."));

    var response = await client.PostAsJsonAsync(
      "/api/automation/triggers",
      new { actionId = Guid.NewGuid(), config = new { type = "manual", label = "Intermission" } });

    Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    var body = await response.Content.ReadAsStringAsync();
    Assert.Contains("Action not found.", body);
  }

  [Fact]
  public async Task CreateIsForbiddenWithAnOverlayToken()
  {
    var (client, store) = BuildOperatorClient();
    var overlay = OverlayToken.Derive(OperatorToken);
    client.DefaultRequestHeaders.Authorization = null;

    var response = await client.PostAsJsonAsync(
      $"/api/automation/triggers?token={overlay}",
      new { actionId = Guid.NewGuid(), config = new { type = "manual", label = "x" } });

    Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    _ = await store.DidNotReceive().CreateAsync(Arg.Any<AutomationTriggerUpsert>(), Arg.Any<CancellationToken>());
  }

  // ---------------------------------------------------------------------------------------
  // PUT /api/automation/triggers/{id}
  // ---------------------------------------------------------------------------------------

  [Fact]
  public async Task UpdateUnknownIdReturns404()
  {
    var (client, store) = BuildOperatorClient();
    var id = Guid.NewGuid();
    _ = store.UpdateAsync(id, Arg.Any<AutomationTriggerUpsert>(), Arg.Any<CancellationToken>())
      .Returns((Result<AutomationTrigger>?)null);

    var response = await client.PutAsJsonAsync(
      $"/api/automation/triggers/{id}",
      new { actionId = Guid.NewGuid(), config = new { type = "manual", label = "x" } });

    Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
  }

  [Fact]
  public async Task UpdateValidationFailureReturns400()
  {
    var (client, store) = BuildOperatorClient();
    var id = Guid.NewGuid();
    _ = store.UpdateAsync(id, Arg.Any<AutomationTriggerUpsert>(), Arg.Any<CancellationToken>())
      .Returns(Result.Fail<AutomationTrigger>("A manual trigger needs a label."));

    var response = await client.PutAsJsonAsync(
      $"/api/automation/triggers/{id}",
      new { actionId = Guid.NewGuid(), config = new { type = "manual", label = "" } });

    Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
  }

  [Fact]
  public async Task UpdateSuccessReturns200WithTheUpdatedTrigger()
  {
    var (client, store) = BuildOperatorClient();
    var id = Guid.NewGuid();
    var updated = BuildTrigger(id: id, config: new ManualTriggerConfig { Label = "Renamed" });
    _ = store.UpdateAsync(id, Arg.Any<AutomationTriggerUpsert>(), Arg.Any<CancellationToken>()).Returns(Result.Ok(updated));

    var response = await client.PutAsJsonAsync(
      $"/api/automation/triggers/{id}",
      new { actionId = updated.ActionId, config = new { type = "manual", label = "Renamed" } });

    Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    var body = await response.Content.ReadAsStringAsync();
    Assert.Contains("\"label\":\"Renamed\"", body);
  }

  // ---------------------------------------------------------------------------------------
  // DELETE /api/automation/triggers/{id}
  // ---------------------------------------------------------------------------------------

  [Fact]
  public async Task DeleteUnknownIdReturns404()
  {
    var (client, store) = BuildOperatorClient();
    var id = Guid.NewGuid();
    _ = store.DeleteAsync(id, Arg.Any<CancellationToken>()).Returns(false);

    var response = await client.DeleteAsync($"/api/automation/triggers/{id}");

    Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
  }

  [Fact]
  public async Task DeleteKnownIdReturns204()
  {
    var (client, store) = BuildOperatorClient();
    var id = Guid.NewGuid();
    _ = store.DeleteAsync(id, Arg.Any<CancellationToken>()).Returns(true);

    var response = await client.DeleteAsync($"/api/automation/triggers/{id}");

    Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
  }

  [Fact]
  public async Task DeleteIsForbiddenWithAnOverlayToken()
  {
    var (client, store) = BuildOperatorClient();
    var overlay = OverlayToken.Derive(OperatorToken);
    client.DefaultRequestHeaders.Authorization = null;
    var id = Guid.NewGuid();

    var response = await client.DeleteAsync($"/api/automation/triggers/{id}?token={overlay}");

    Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    _ = await store.DidNotReceive().DeleteAsync(Arg.Any<Guid>(), Arg.Any<CancellationToken>());
  }
}
