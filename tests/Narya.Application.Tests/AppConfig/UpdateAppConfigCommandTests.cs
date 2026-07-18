using FluentResults;

using MediatR;

using NSubstitute;

using Narya.Application.AppConfig;
using Narya.Application.AppConfig.Notifications;
using Narya.Core.AppConfig;
using Narya.Core.Twitch;

using DomainConfig = Narya.Domain.AppConfig.AppConfig;

namespace Narya.Application.Tests.AppConfig;

public sealed class UpdateAppConfigCommandTests
{
  /// <summary>
  /// Wires a store whose pre-update <c>GetAsync</c> returns <paramref name="before"/> and whose
  /// <c>UpdateAsync</c> returns <paramref name="after"/> — the two halves the handler compares
  /// to decide whether the Twitch identity actually moved.
  /// </summary>
  private static IAppConfigStore StoreReturning(DomainConfig before, DomainConfig after)
  {
    var store = Substitute.For<IAppConfigStore>();
    _ = store.GetAsync(Arg.Any<CancellationToken>()).Returns(Result.Ok(before));
    _ = store.UpdateAsync(Arg.Any<AppConfigPatch>(), Arg.Any<CancellationToken>()).Returns(Result.Ok(after));
    return store;
  }

  [Fact]
  public async Task MasksSecretsInTheResponse()
  {
    var config = new DomainConfig { TwitchClientSecret = "s3cret", TwitchChannel = "codeacula" };
    var handler = new UpdateAppConfigCommandHandler(
      StoreReturning(config, config), Substitute.For<IMediator>(), Substitute.For<ITwitchIdentityInvalidator>());

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
    var mediator = Substitute.For<IMediator>();
    var handler = new UpdateAppConfigCommandHandler(
      StoreReturning(new DomainConfig(), new DomainConfig()), mediator, Substitute.For<ITwitchIdentityInvalidator>());

    _ = await handler.Handle(new UpdateAppConfigCommand(new AppConfigPatch()), CancellationToken.None);

    await mediator.Received(1).Publish(Arg.Any<AppConfigUpdatedNotification>(), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task PropagatesStoreFailureWithoutPublishing()
  {
    var store = Substitute.For<IAppConfigStore>();
    _ = store.GetAsync(Arg.Any<CancellationToken>()).Returns(Result.Ok(new DomainConfig()));
    _ = store.UpdateAsync(Arg.Any<AppConfigPatch>(), Arg.Any<CancellationToken>())
      .Returns(Result.Fail<DomainConfig>("store unavailable"));
    var mediator = Substitute.For<IMediator>();
    var invalidator = Substitute.For<ITwitchIdentityInvalidator>();
    var handler = new UpdateAppConfigCommandHandler(store, mediator, invalidator);

    var result = await handler.Handle(new UpdateAppConfigCommand(new AppConfigPatch()), CancellationToken.None);

    Assert.True(result.IsFailed);
    Assert.Contains(result.Errors, e => e.Message == "store unavailable");
    await mediator.DidNotReceive().Publish(Arg.Any<AppConfigUpdatedNotification>(), Arg.Any<CancellationToken>());

    // A failed update changed nothing, so nothing may be invalidated — otherwise a store
    // outage would drop the cached broadcaster id and churn EventSub for no reason.
    await invalidator.DidNotReceive().InvalidateAsync(Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task ChangingTheTwitchChannelInvalidatesTheCachedIdentity()
  {
    var invalidator = Substitute.For<ITwitchIdentityInvalidator>();
    var handler = new UpdateAppConfigCommandHandler(
      StoreReturning(
        new DomainConfig { TwitchChannel = "old-channel" },
        new DomainConfig { TwitchChannel = "new-channel" }),
      Substitute.For<IMediator>(),
      invalidator);

    _ = await handler.Handle(
      new UpdateAppConfigCommand(new AppConfigPatch { TwitchChannel = "new-channel" }), CancellationToken.None);

    await invalidator.Received(1).InvalidateAsync(Arg.Any<CancellationToken>());
  }

  [Theory]
  [InlineData("client-id")]
  [InlineData("client-secret")]
  public async Task ChangingTheTwitchClientCredentialsInvalidatesTheCachedIdentity(string field)
  {
    var before = new DomainConfig { TwitchClientId = "id-1", TwitchClientSecret = "secret-1" };
    var after = field == "client-id"
      ? before with { TwitchClientId = "id-2" }
      : before with { TwitchClientSecret = "secret-2" };
    var invalidator = Substitute.For<ITwitchIdentityInvalidator>();
    var handler = new UpdateAppConfigCommandHandler(
      StoreReturning(before, after), Substitute.For<IMediator>(), invalidator);

    _ = await handler.Handle(new UpdateAppConfigCommand(new AppConfigPatch()), CancellationToken.None);

    await invalidator.Received(1).InvalidateAsync(Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task ChangingAnUnrelatedFieldDoesNotInvalidateAnything()
  {
    var before = new DomainConfig { TwitchChannel = "codeacula", TwitchClientId = "id-1", SoundVolume = 0.5 };
    var invalidator = Substitute.For<ITwitchIdentityInvalidator>();
    var handler = new UpdateAppConfigCommandHandler(
      StoreReturning(before, before with { SoundVolume = 0.9 }), Substitute.For<IMediator>(), invalidator);

    _ = await handler.Handle(
      new UpdateAppConfigCommand(new AppConfigPatch { SoundVolume = 0.9 }), CancellationToken.None);

    // The load-bearing assertion: a volume change must never churn EventSub — reconnecting
    // would drop the live socket mid-stream for a setting Twitch has never heard of.
    await invalidator.DidNotReceive().InvalidateAsync(Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task ResubmittingTheSameTwitchValuesDoesNotInvalidateAnything()
  {
    // The Settings form posts its whole Twitch section on every save, so "the patch mentions
    // TwitchChannel" is not evidence the channel changed.
    var config = new DomainConfig { TwitchChannel = "codeacula", TwitchClientId = "id-1", TwitchClientSecret = "s-1" };
    var invalidator = Substitute.For<ITwitchIdentityInvalidator>();
    var handler = new UpdateAppConfigCommandHandler(
      StoreReturning(config, config), Substitute.For<IMediator>(), invalidator);

    _ = await handler.Handle(
      new UpdateAppConfigCommand(new AppConfigPatch
      {
        TwitchChannel = "codeacula",
        TwitchClientId = "id-1",
        TwitchClientSecret = "s-1",
      }),
      CancellationToken.None);

    await invalidator.DidNotReceive().InvalidateAsync(Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task ASaveChangingEveryTwitchFieldInvalidatesExactlyOnce()
  {
    var invalidator = Substitute.For<ITwitchIdentityInvalidator>();
    var handler = new UpdateAppConfigCommandHandler(
      StoreReturning(
        new DomainConfig { TwitchChannel = "old", TwitchClientId = "id-1", TwitchClientSecret = "s-1" },
        new DomainConfig { TwitchChannel = "new", TwitchClientId = "id-2", TwitchClientSecret = "s-2" }),
      Substitute.For<IMediator>(),
      invalidator);

    _ = await handler.Handle(
      new UpdateAppConfigCommand(new AppConfigPatch
      {
        TwitchChannel = "new",
        TwitchClientId = "id-2",
        TwitchClientSecret = "s-2",
      }),
      CancellationToken.None);

    // Exactly one — one invalidation means one EventSub reconnect, not three.
    await invalidator.Received(1).InvalidateAsync(Arg.Any<CancellationToken>());
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
