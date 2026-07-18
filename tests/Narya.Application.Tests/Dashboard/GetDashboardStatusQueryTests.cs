using FluentResults;

using NSubstitute;

using Narya.Application.Dashboard;
using Narya.Core.AppConfig;
using Narya.Core.Chat;
using Narya.Core.Dashboard;
using Narya.Core.Sessions;

using DomainConfig = Narya.Domain.AppConfig.AppConfig;

namespace Narya.Application.Tests.Dashboard;

public sealed class GetDashboardStatusQueryTests
{
  private sealed class FixedTimeProvider(DateTimeOffset now) : TimeProvider
  {
    public override DateTimeOffset GetUtcNow() => now;
  }

  private static (
    IChatStore ChatStore,
    IStreamSessionStore SessionStore,
    IAppConfigStore AppConfigStore,
    IDashboardTwitchStatusProvider TwitchStatusProvider) BuildDefaultSubstitutes()
  {
    var chatStore = Substitute.For<IChatStore>();
    _ = chatStore.GetActiveChatterCountAsync(Arg.Any<DateTimeOffset>(), Arg.Any<CancellationToken>()).Returns(0);
    _ = chatStore.GetKnownChatterCountAsync(Arg.Any<CancellationToken>()).Returns(0);

    var sessionStore = Substitute.For<IStreamSessionStore>();
    _ = sessionStore.GetSessionChatterCountAsync(Arg.Any<CancellationToken>()).Returns(0);
    _ = sessionStore.GetActiveSessionAsync(Arg.Any<CancellationToken>()).Returns((StreamSession?)null);

    var appConfigStore = Substitute.For<IAppConfigStore>();
    _ = appConfigStore.GetAsync(Arg.Any<CancellationToken>())
      .Returns(Result.Ok(new DomainConfig { TwitchChannel = "codeacula" }));

    var twitchStatusProvider = Substitute.For<IDashboardTwitchStatusProvider>();
    _ = twitchStatusProvider.GetAsync(Arg.Any<CancellationToken>()).Returns(new DashboardTwitchStatus
    {
      TwitchAuthenticated = false,
      TwitchMissingScopes = [],
      TwitchBotAuthenticated = false,
      TwitchBotMissingScopes = [],
      EventSubConnected = false,
      EventSubFailedSubscriptions = [],
    });

    return (chatStore, sessionStore, appConfigStore, twitchStatusProvider);
  }

  [Fact]
  public async Task AggregatesThePersistenceBackedCounts()
  {
    var (chatStore, sessionStore, appConfigStore, twitchStatusProvider) = BuildDefaultSubstitutes();
    var now = DateTimeOffset.Parse("2026-07-17T12:00:00Z", System.Globalization.CultureInfo.InvariantCulture);
    _ = chatStore.GetActiveChatterCountAsync(Arg.Any<DateTimeOffset>(), Arg.Any<CancellationToken>()).Returns(7);
    _ = chatStore.GetKnownChatterCountAsync(Arg.Any<CancellationToken>()).Returns(42);
    _ = sessionStore.GetSessionChatterCountAsync(Arg.Any<CancellationToken>()).Returns(3);
    var activeSession = new StreamSession(
      Id: "session-1", StartedAt: now.AddHours(-1), EndedAt: null, Source: "twitch:123",
      DiscordMessageId: null, DiscordChannelId: null, DiscordAnnounceError: null,
      DiscordAnnounceAttempts: 0, DiscordAnnounceTerminal: false);
    _ = sessionStore.GetActiveSessionAsync(Arg.Any<CancellationToken>()).Returns(activeSession);
    var handler = new GetDashboardStatusQueryHandler(
      chatStore, sessionStore, appConfigStore, twitchStatusProvider, new FixedTimeProvider(now));

    var status = await handler.Handle(new GetDashboardStatusQuery(), CancellationToken.None);

    Assert.Equal(7, status.ActiveChatters);
    Assert.Equal(42, status.KnownChatters);
    Assert.Equal(3, status.SessionChatters);
    Assert.Equal("session-1", status.StreamSessionId);
    Assert.Equal(now.AddHours(-1), status.StreamSessionStartedAt);
    Assert.Equal("codeacula", status.Channel);
  }

  [Fact]
  public async Task UsesTheFifteenMinuteWindowForActiveChatters()
  {
    var (chatStore, sessionStore, appConfigStore, twitchStatusProvider) = BuildDefaultSubstitutes();
    var now = DateTimeOffset.Parse("2026-07-17T12:00:00Z", System.Globalization.CultureInfo.InvariantCulture);
    var handler = new GetDashboardStatusQueryHandler(
      chatStore, sessionStore, appConfigStore, twitchStatusProvider, new FixedTimeProvider(now));

    _ = await handler.Handle(new GetDashboardStatusQuery(), CancellationToken.None);

    _ = await chatStore.Received(1).GetActiveChatterCountAsync(now.AddMinutes(-15), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task AggregatesAuthAndEventSubStatus()
  {
    var (chatStore, sessionStore, appConfigStore, twitchStatusProvider) = BuildDefaultSubstitutes();
    _ = twitchStatusProvider.GetAsync(Arg.Any<CancellationToken>()).Returns(new DashboardTwitchStatus
    {
      TwitchAuthenticated = true,
      TwitchAuthSource = "oauth",
      TwitchTokenExpiresAt = DateTimeOffset.UtcNow.AddHours(1),
      TwitchMissingScopes = ["channel:read:ads"],
      TwitchBotAuthenticated = false,
      TwitchBotMissingScopes = [],
      EventSubConnected = true,
      EventSubError = "boom",
      EventSubFailedSubscriptions = [],
    });
    var handler = new GetDashboardStatusQueryHandler(
      chatStore, sessionStore, appConfigStore, twitchStatusProvider, new FixedTimeProvider(DateTimeOffset.UtcNow));

    var status = await handler.Handle(new GetDashboardStatusQuery(), CancellationToken.None);

    Assert.True(status.TwitchAuthenticated);
    Assert.Equal("oauth", status.TwitchAuthSource);
    Assert.Equal(["channel:read:ads"], status.TwitchMissingScopes);
    Assert.False(status.TwitchBotAuthenticated);
    Assert.True(status.EventSubConnected);
    Assert.Equal("boom", status.EventSubError);
    Assert.Equal("OPEN", status.ChatConnection); // mirrors EventSubConnected — see DashboardStatus.ChatConnection's doc comment
  }

  [Fact]
  public async Task ObsAndAdScheduleFieldsDefaultToNullOrFalse()
  {
    var (chatStore, sessionStore, appConfigStore, twitchStatusProvider) = BuildDefaultSubstitutes();
    var handler = new GetDashboardStatusQueryHandler(
      chatStore, sessionStore, appConfigStore, twitchStatusProvider, new FixedTimeProvider(DateTimeOffset.UtcNow));

    var status = await handler.Handle(new GetDashboardStatusQuery(), CancellationToken.None);

    Assert.False(status.ObsConnected);
    Assert.Null(status.StreamActive);
    Assert.Null(status.UptimeSeconds);
    Assert.Null(status.StreamStartedAt);
    Assert.Null(status.ViewerCount);
    Assert.Null(status.BitrateKbps);
    Assert.Null(status.Congestion);
    Assert.Null(status.TotalFrames);
    Assert.Null(status.DroppedFrames);
    Assert.Null(status.LaggedFrames);
    Assert.Null(status.AdBreakEndsAt);
    Assert.Null(status.AdScheduleStatus);
    Assert.Null(status.AdScheduleError);
    Assert.Null(status.NextAdAt);
    Assert.Null(status.LastAdAt);
    Assert.Null(status.AdBreakDurationSeconds);
    Assert.Null(status.PrerollFreeTimeSeconds);
    Assert.Null(status.SnoozeCount);
    Assert.Null(status.SnoozeRefreshAt);
  }

  [Fact]
  public async Task ChannelFallsBackToEmptyStringWhenTheConfigStoreFails()
  {
    var (chatStore, sessionStore, appConfigStore, twitchStatusProvider) = BuildDefaultSubstitutes();
    _ = appConfigStore.GetAsync(Arg.Any<CancellationToken>()).Returns(Result.Fail<DomainConfig>("store unavailable"));
    var handler = new GetDashboardStatusQueryHandler(
      chatStore, sessionStore, appConfigStore, twitchStatusProvider, new FixedTimeProvider(DateTimeOffset.UtcNow));

    var status = await handler.Handle(new GetDashboardStatusQuery(), CancellationToken.None);

    Assert.Equal(string.Empty, status.Channel);
  }
}
