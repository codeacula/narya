using FluentResults;

using MediatR;

using NSubstitute;

using Narya.Application.AppConfig;
using Narya.Application.AppConfig.Notifications;
using Narya.Core.AppConfig;

using DomainConfig = Narya.Domain.AppConfig.AppConfig;

namespace Narya.Application.Tests.AppConfig;

public sealed class UpdateAppConfigCommandTests
{
  [Fact]
  public async Task MasksSecretsInTheResponse()
  {
    var store = Substitute.For<IAppConfigStore>();
    _ = store.UpdateAsync(Arg.Any<AppConfigPatch>(), Arg.Any<CancellationToken>())
      .Returns(Result.Ok(new DomainConfig { TwitchClientSecret = "s3cret", TwitchChannel = "codeacula" }));
    var handler = new UpdateAppConfigCommandHandler(store, Substitute.For<IMediator>());

    var result = await handler.Handle(
      new UpdateAppConfigCommand(new AppConfigPatch { TwitchChannel = "codeacula" }), CancellationToken.None);

    Assert.True(result.IsSuccess);
    Assert.True(result.Value.TwitchClientSecretConfigured);
    Assert.Equal("codeacula", result.Value.TwitchChannel);
    var serialized = System.Text.Json.JsonSerializer.Serialize(result.Value);
    Assert.DoesNotContain("s3cret", serialized); // the load-bearing assertion
  }

  [Fact]
  public async Task PublishesSettingsUpdatedNotification()
  {
    var store = Substitute.For<IAppConfigStore>();
    _ = store.UpdateAsync(Arg.Any<AppConfigPatch>(), Arg.Any<CancellationToken>())
      .Returns(Result.Ok(new DomainConfig()));
    var mediator = Substitute.For<IMediator>();
    var handler = new UpdateAppConfigCommandHandler(store, mediator);

    _ = await handler.Handle(new UpdateAppConfigCommand(new AppConfigPatch()), CancellationToken.None);

    await mediator.Received(1).Publish(Arg.Any<AppConfigUpdatedNotification>(), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task PropagatesStoreFailureWithoutPublishing()
  {
    var store = Substitute.For<IAppConfigStore>();
    _ = store.UpdateAsync(Arg.Any<AppConfigPatch>(), Arg.Any<CancellationToken>())
      .Returns(Result.Fail<DomainConfig>("store unavailable"));
    var mediator = Substitute.For<IMediator>();
    var handler = new UpdateAppConfigCommandHandler(store, mediator);

    var result = await handler.Handle(new UpdateAppConfigCommand(new AppConfigPatch()), CancellationToken.None);

    Assert.True(result.IsFailed);
    Assert.Contains(result.Errors, e => e.Message == "store unavailable");
    await mediator.DidNotReceive().Publish(Arg.Any<AppConfigUpdatedNotification>(), Arg.Any<CancellationToken>());
  }
}

public sealed class UpdateAppConfigCommandValidatorTests
{
  private readonly UpdateAppConfigCommandValidator validator = new();

  [Fact]
  public void FailsWhenSoundVolumeIsOutOfRange()
  {
    var result = validator.Validate(new UpdateAppConfigCommand(new AppConfigPatch { SoundVolume = 1.5 }));

    Assert.False(result.IsValid);
  }

  [Fact]
  public void FailsWhenMusicPollIntervalMsIsOutOfRange()
  {
    var result = validator.Validate(new UpdateAppConfigCommand(new AppConfigPatch { MusicPollIntervalMs = -1 }));

    Assert.False(result.IsValid);
  }

  [Fact]
  public void PassesWithValuesWithinBounds()
  {
    var result = validator.Validate(
      new UpdateAppConfigCommand(new AppConfigPatch { SoundVolume = 0.8, MusicPollIntervalMs = 2000 }));

    Assert.True(result.IsValid);
  }

  [Fact]
  public void PassesWithAnAllNullPatch()
  {
    var result = validator.Validate(new UpdateAppConfigCommand(new AppConfigPatch()));

    Assert.True(result.IsValid);
  }
}
