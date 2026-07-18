using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;

using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;

using Narya.Api.Auth;
using Narya.Application.Actions;
using Narya.Application.Automation;
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
/// Exercises <c>POST /api/automation/slash</c> through a real host under
/// <c>Narya:SkipInfrastructure=true</c> — same shape as <c>AutomationTriggersControllerTests</c>'s
/// Run-route tests, since both need a controlled <see cref="ITriggerDispatcher"/>. Deliberately NOT
/// on <c>DashboardTokenMiddleware.OverlayPaths</c>.
/// </summary>
public sealed class AutomationControllerTests
{
  private const string OperatorToken = "op-token";

  private static (HttpClient Client, ITriggerDispatcher Dispatcher) BuildOperatorClient()
  {
    var dispatcher = Substitute.For<ITriggerDispatcher>();

    var client = new WebApplicationFactory<Program>()
      .WithWebHostBuilder(b =>
      {
        _ = b.UseSetting("Narya:DashboardToken", OperatorToken);
        _ = b.UseSetting("Narya:SkipInfrastructure", "true");

        _ = b.ConfigureTestServices(services =>
        {
          _ = services.AddSingleton(dispatcher);
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
          _ = services.AddSingleton(Substitute.For<IAutomationTriggerStore>());
          _ = services.AddSingleton(Substitute.For<IAutomationRunStore>());
        });
      })
      .CreateClient();

    client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", OperatorToken);
    return (client, dispatcher);
  }

  [Fact]
  public async Task SlashUnknownCommandReturns200WithOkFalse()
  {
    var (client, dispatcher) = BuildOperatorClient();
    _ = dispatcher.HandleSlashCommandAsync(Arg.Any<string?>(), Arg.Any<CancellationToken>())
      .Returns(new SlashCommandResponse(false, "Unknown command /nosuch.", null));

    var response = await client.PostAsJsonAsync("/api/automation/slash", new SlashCommandRequest { Input = "/nosuch target" });

    Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    var body = await response.Content.ReadAsStringAsync();
    Assert.Contains("\"ok\":false", body, StringComparison.Ordinal);
  }

  [Fact]
  public async Task SlashSuccessReturns200WithOkTrueAndTheRunResult()
  {
    var (client, dispatcher) = BuildOperatorClient();
    var run = new ActionRunResult(Guid.NewGuid(), ActionRunStatus.Succeeded, [], DateTimeOffset.UtcNow);
    _ = dispatcher.HandleSlashCommandAsync(Arg.Any<string?>(), Arg.Any<CancellationToken>())
      .Returns(new SlashCommandResponse(true, "/shoutout ran.", run));

    var response = await client.PostAsJsonAsync("/api/automation/slash", new SlashCommandRequest { Input = "/shoutout someviewer" });

    Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    var body = await response.Content.ReadAsStringAsync();
    Assert.Contains("\"ok\":true", body, StringComparison.Ordinal);
    _ = await dispatcher.Received(1).HandleSlashCommandAsync("/shoutout someviewer", Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task SlashIsForbiddenWithAnOverlayToken()
  {
    var (client, dispatcher) = BuildOperatorClient();
    var overlay = OverlayToken.Derive(OperatorToken);
    client.DefaultRequestHeaders.Authorization = null;

    var response = await client.PostAsJsonAsync(
      $"/api/automation/slash?token={overlay}", new SlashCommandRequest { Input = "/shoutout someviewer" });

    Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    _ = await dispatcher.DidNotReceive().HandleSlashCommandAsync(Arg.Any<string?>(), Arg.Any<CancellationToken>());
  }
}
