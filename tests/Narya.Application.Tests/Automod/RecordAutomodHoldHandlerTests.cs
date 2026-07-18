using FluentResults;

using MediatR;

using NSubstitute;

using Narya.Application.Automod;
using Narya.Core.AppConfig;
using Narya.Core.Automod;

using DomainConfig = Narya.Domain.AppConfig.AppConfig;

namespace Narya.Application.Tests.Automod;

public sealed class RecordAutomodHoldHandlerTests
{
  private sealed record Fixture(IAutomodStore AutomodStore, IAppConfigStore AppConfigStore, IMediator Mediator, RecordAutomodHoldHandler Handler);

  private static Fixture Build(bool inserted = true, string configuredChannel = "codeacula")
  {
    var automodStore = Substitute.For<IAutomodStore>();
    var appConfigStore = Substitute.For<IAppConfigStore>();
    var mediator = Substitute.For<IMediator>();

    _ = automodStore.RecordHoldAsync(Arg.Any<AutomodHold>(), Arg.Any<CancellationToken>()).Returns(inserted);
    _ = appConfigStore.GetAsync(Arg.Any<CancellationToken>())
      .Returns(Result.Ok(new DomainConfig { TwitchChannel = configuredChannel }));

    var handler = new RecordAutomodHoldHandler(automodStore, appConfigStore, mediator);
    return new Fixture(automodStore, appConfigStore, mediator, handler);
  }

  private static AutomodHeldNotification BuildNotification(
    string channel = "codeacula", string username = "riskyviewer", string displayName = "RiskyViewer") => new(
      MessageId: "held-1", Channel: channel, Username: username, DisplayName: displayName,
      Message: "questionable text", Reason: "automod", Category: "profanity", Level: 2, HeldAt: DateTimeOffset.UtcNow);

  [Fact]
  public async Task OnAGenuineInsertRecordsTheHoldAndBroadcasts()
  {
    var f = Build(inserted: true);

    await f.Handler.Handle(BuildNotification(), CancellationToken.None);

    _ = await f.AutomodStore.Received(1).RecordHoldAsync(
      Arg.Is<AutomodHold>(h => h.Id == "held-1" && h.Channel == "codeacula" && h.Username == "riskyviewer"),
      Arg.Any<CancellationToken>());
    await f.Mediator.Received(1).Publish(
      Arg.Is<AutomodHeldBroadcastNotification>(n => n.Hold.Id == "held-1"), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task OnARedeliveryNeverBroadcasts()
  {
    var f = Build(inserted: false);

    await f.Handler.Handle(BuildNotification(), CancellationToken.None);

    await f.Mediator.DidNotReceive().Publish(Arg.Any<AutomodHeldBroadcastNotification>(), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task FallsBackToTheConfiguredChannelWhenTwitchOmitsOne()
  {
    var f = Build(inserted: true, configuredChannel: "configured-channel");

    await f.Handler.Handle(BuildNotification(channel: string.Empty), CancellationToken.None);

    _ = await f.AutomodStore.Received(1).RecordHoldAsync(
      Arg.Is<AutomodHold>(h => h.Channel == "configured-channel"), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task UsesTwitchsChannelWhenPresentRatherThanTheConfiguredOne()
  {
    var f = Build(inserted: true, configuredChannel: "configured-channel");

    await f.Handler.Handle(BuildNotification(channel: "raw-broadcaster-login"), CancellationToken.None);

    _ = await f.AutomodStore.Received(1).RecordHoldAsync(
      Arg.Is<AutomodHold>(h => h.Channel == "raw-broadcaster-login"), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task BlankUsernameAndDisplayNameFallBackToUnknown()
  {
    var f = Build(inserted: true);

    await f.Handler.Handle(BuildNotification(username: string.Empty, displayName: string.Empty), CancellationToken.None);

    _ = await f.AutomodStore.Received(1).RecordHoldAsync(
      Arg.Is<AutomodHold>(h => h.Username == "unknown" && h.DisplayName == "unknown"), Arg.Any<CancellationToken>());
  }
}
