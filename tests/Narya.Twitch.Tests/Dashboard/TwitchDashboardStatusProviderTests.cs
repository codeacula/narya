using FluentResults;

using NSubstitute;

using Narya.Twitch.Dashboard;
using Narya.Twitch.EventSub;
using Narya.Twitch.Tokens;

namespace Narya.Twitch.Tests.Dashboard;

public sealed class TwitchDashboardStatusProviderTests
{
  [Fact]
  public async Task NoStoredTokensReportUnauthenticatedWithNoMissingScopes()
  {
    var tokenStore = Substitute.For<ITwitchTokenStore>();
    _ = tokenStore.GetAsync(TwitchProvider.Broadcaster, Arg.Any<CancellationToken>()).Returns(Result.Ok<TwitchToken?>(null));
    _ = tokenStore.GetAsync(TwitchProvider.Bot, Arg.Any<CancellationToken>()).Returns(Result.Ok<TwitchToken?>(null));
    var eventSource = Substitute.For<ITwitchEventSource>();
    _ = eventSource.Status.Returns(EventSubStatus.Initial);
    var provider = new TwitchDashboardStatusProvider(tokenStore, eventSource);

    var status = await provider.GetAsync(CancellationToken.None);

    Assert.False(status.TwitchAuthenticated);
    Assert.Null(status.TwitchAuthSource);
    Assert.Empty(status.TwitchMissingScopes);
    Assert.False(status.TwitchBotAuthenticated);
    Assert.Null(status.TwitchBotAuthSource);
    Assert.Empty(status.TwitchBotMissingScopes);
  }

  [Fact]
  public async Task AStoredBroadcasterTokenMissingAScopeReportsIt()
  {
    var tokenStore = Substitute.For<ITwitchTokenStore>();
    var token = new TwitchToken
    {
      AccessToken = "token",
      Scopes = [.. Scopes.Broadcaster.Where(s => s != "channel:read:ads")],
      ExpiresAt = DateTimeOffset.UtcNow.AddHours(1),
    };
    _ = tokenStore.GetAsync(TwitchProvider.Broadcaster, Arg.Any<CancellationToken>()).Returns(Result.Ok<TwitchToken?>(token));
    _ = tokenStore.GetAsync(TwitchProvider.Bot, Arg.Any<CancellationToken>()).Returns(Result.Ok<TwitchToken?>(null));
    var eventSource = Substitute.For<ITwitchEventSource>();
    _ = eventSource.Status.Returns(EventSubStatus.Initial);
    var provider = new TwitchDashboardStatusProvider(tokenStore, eventSource);

    var status = await provider.GetAsync(CancellationToken.None);

    Assert.True(status.TwitchAuthenticated);
    Assert.Equal("oauth", status.TwitchAuthSource);
    Assert.Equal(token.ExpiresAt, status.TwitchTokenExpiresAt);
    Assert.Equal(["channel:read:ads"], status.TwitchMissingScopes);
  }

  [Fact]
  public async Task AFailedTokenLookupDegradesToNotAuthenticatedRatherThanThrowing()
  {
    var tokenStore = Substitute.For<ITwitchTokenStore>();
    _ = tokenStore.GetAsync(TwitchProvider.Broadcaster, Arg.Any<CancellationToken>()).Returns(Result.Fail<TwitchToken?>("store unavailable"));
    _ = tokenStore.GetAsync(TwitchProvider.Bot, Arg.Any<CancellationToken>()).Returns(Result.Fail<TwitchToken?>("store unavailable"));
    var eventSource = Substitute.For<ITwitchEventSource>();
    _ = eventSource.Status.Returns(EventSubStatus.Initial);
    var provider = new TwitchDashboardStatusProvider(tokenStore, eventSource);

    var status = await provider.GetAsync(CancellationToken.None);

    Assert.False(status.TwitchAuthenticated);
    Assert.False(status.TwitchBotAuthenticated);
  }

  [Fact]
  public async Task ReflectsTheEventSourcesConnectionStatus()
  {
    var tokenStore = Substitute.For<ITwitchTokenStore>();
    _ = tokenStore.GetAsync(Arg.Any<TwitchProvider>(), Arg.Any<CancellationToken>()).Returns(Result.Ok<TwitchToken?>(null));
    var eventSource = Substitute.For<ITwitchEventSource>();
    _ = eventSource.Status.Returns(new EventSubStatus { Connected = true, LastError = "boom", SessionId = "session-1" });
    var provider = new TwitchDashboardStatusProvider(tokenStore, eventSource);

    var status = await provider.GetAsync(CancellationToken.None);

    Assert.True(status.EventSubConnected);
    Assert.Equal("boom", status.EventSubError);
    Assert.Empty(status.EventSubFailedSubscriptions);
  }
}
