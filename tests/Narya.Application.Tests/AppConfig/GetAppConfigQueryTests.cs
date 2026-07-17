using FluentResults;

using NSubstitute;

using Narya.Application.AppConfig;
using Narya.Core.AppConfig;

using DomainConfig = Narya.Domain.AppConfig.AppConfig;

namespace Narya.Application.Tests.AppConfig;

public sealed class GetAppConfigQueryTests
{
  [Fact]
  public async Task ReturnsTheMaskedResponseOnSuccess()
  {
    var store = Substitute.For<IAppConfigStore>();
    _ = store.GetAsync(Arg.Any<CancellationToken>())
      .Returns(Result.Ok(new DomainConfig { DiscordBotToken = "s3cret", TwitchChannel = "codeacula" }));
    var handler = new GetAppConfigQueryHandler(store);

    var result = await handler.Handle(new GetAppConfigQuery(), CancellationToken.None);

    Assert.True(result.IsSuccess);
    Assert.True(result.Value.DiscordBotTokenConfigured);
    Assert.Equal("codeacula", result.Value.TwitchChannel);
  }

  [Fact]
  public async Task PropagatesStoreFailure()
  {
    var store = Substitute.For<IAppConfigStore>();
    _ = store.GetAsync(Arg.Any<CancellationToken>()).Returns(Result.Fail<DomainConfig>("store unavailable"));
    var handler = new GetAppConfigQueryHandler(store);

    var result = await handler.Handle(new GetAppConfigQuery(), CancellationToken.None);

    Assert.True(result.IsFailed);
    Assert.Contains(result.Errors, e => e.Message == "store unavailable");
  }
}
