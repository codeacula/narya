using MediatR;

using NSubstitute;

using Narya.Application.Automod;
using Narya.Core.Automod;

namespace Narya.Application.Tests.Automod;

public sealed class ResolveAutomodHoldHandlerTests
{
  private sealed record Fixture(IAutomodStore AutomodStore, IMediator Mediator, ResolveAutomodHoldHandler Handler);

  private static Fixture Build()
  {
    var automodStore = Substitute.For<IAutomodStore>();
    var mediator = Substitute.For<IMediator>();
    var handler = new ResolveAutomodHoldHandler(automodStore, mediator);
    return new Fixture(automodStore, mediator, handler);
  }

  private static AutomodHold BuildHold(string resolution) => new(
    Id: "held-1", Channel: "codeacula", Username: "viewer", DisplayName: "Viewer", Message: "hi",
    Category: null, Level: null, HeldAt: DateTimeOffset.UtcNow,
    ResolvedAt: DateTimeOffset.UtcNow, Resolution: resolution, ResolvedBy: "ModeratorName");

  [Theory]
  [InlineData("Approved", "allowed")]
  [InlineData("Denied", "denied")]
  [InlineData("Expired", "expired")]
  [InlineData("something-unrecognized", "expired")]
  public async Task NormalizesTwitchsStatusAndCallsResolveHoldAuthoritatively(string rawStatus, string expectedResolution)
  {
    var f = Build();
    _ = f.AutomodStore.ResolveHoldAsync(
        "held-1", expectedResolution, "ModeratorName", true, Arg.Any<CancellationToken>())
      .Returns(new AutomodResolveResult(BuildHold(expectedResolution), true));

    await f.Handler.Handle(new AutomodResolvedNotification("held-1", rawStatus, "ModeratorName"), CancellationToken.None);

    _ = await f.AutomodStore.Received(1).ResolveHoldAsync(
      "held-1", expectedResolution, "ModeratorName", true, Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task PublishesTheBroadcastOnlyWhenTheStoreReportsAChange()
  {
    var f = Build();
    _ = f.AutomodStore.ResolveHoldAsync(
        Arg.Any<string>(), Arg.Any<string>(), Arg.Any<string?>(), Arg.Any<bool>(), Arg.Any<CancellationToken>())
      .Returns(new AutomodResolveResult(BuildHold("allowed"), true));

    await f.Handler.Handle(new AutomodResolvedNotification("held-1", "Approved", "ModeratorName"), CancellationToken.None);

    await f.Mediator.Received(1).Publish(
      Arg.Is<AutomodResolvedBroadcastNotification>(n => n.Hold.Id == "held-1"), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task NeverBroadcastsWhenTheStoreReportsNoChange()
  {
    var f = Build();
    _ = f.AutomodStore.ResolveHoldAsync(
        Arg.Any<string>(), Arg.Any<string>(), Arg.Any<string?>(), Arg.Any<bool>(), Arg.Any<CancellationToken>())
      .Returns(new AutomodResolveResult(BuildHold("denied"), false));

    await f.Handler.Handle(new AutomodResolvedNotification("held-1", "Approved", "ModeratorName"), CancellationToken.None);

    await f.Mediator.DidNotReceive().Publish(Arg.Any<AutomodResolvedBroadcastNotification>(), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task NeverBroadcastsForAnUnknownId()
  {
    var f = Build();
    _ = f.AutomodStore.ResolveHoldAsync(
        Arg.Any<string>(), Arg.Any<string>(), Arg.Any<string?>(), Arg.Any<bool>(), Arg.Any<CancellationToken>())
      .Returns(new AutomodResolveResult(null, false));

    await f.Handler.Handle(new AutomodResolvedNotification("does-not-exist", "Approved", "ModeratorName"), CancellationToken.None);

    await f.Mediator.DidNotReceive().Publish(Arg.Any<AutomodResolvedBroadcastNotification>(), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task BlankModeratorNameResolvesToNullResolvedBy()
  {
    var f = Build();
    _ = f.AutomodStore.ResolveHoldAsync(
        "held-1", "allowed", null, true, Arg.Any<CancellationToken>())
      .Returns(new AutomodResolveResult(BuildHold("allowed"), true));

    await f.Handler.Handle(new AutomodResolvedNotification("held-1", "Approved", string.Empty), CancellationToken.None);

    _ = await f.AutomodStore.Received(1).ResolveHoldAsync("held-1", "allowed", null, true, Arg.Any<CancellationToken>());
  }
}
