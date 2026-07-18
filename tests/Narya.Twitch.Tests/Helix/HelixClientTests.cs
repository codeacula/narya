using FluentResults;

using Newtonsoft.Json;

using NSubstitute;

using Narya.Core.AppConfig;
using Narya.Twitch.Helix;
using Narya.Twitch.Tokens;

using TwitchLib.Api.Core.Enums;
using TwitchLib.Api.Core.Exceptions;
using TwitchLib.Api.Helix.Models.Channels.GetAdSchedule;
using TwitchLib.Api.Helix.Models.Channels.GetChannelInformation;
using TwitchLib.Api.Helix.Models.Channels.ModifyChannelInformation;
using TwitchLib.Api.Helix.Models.Channels.SendChatMessage;
using TwitchLib.Api.Helix.Models.Channels.StartCommercial;
using TwitchLib.Api.Helix.Models.EventSub;
using TwitchLib.Api.Helix.Models.Games;
using TwitchLib.Api.Helix.Models.Moderation.BanUser;
using TwitchLib.Api.Helix.Models.Search;
using TwitchLib.Api.Helix.Models.Streams.GetStreams;
using TwitchLib.Api.Helix.Models.Users.GetUsers;

using DomainConfig = Narya.Domain.AppConfig.AppConfig;

namespace Narya.Twitch.Tests.Helix;

/// <summary>
/// Exercises <see cref="HelixClient"/> against a substituted <see cref="IHelixApi"/> — no real
/// TwitchLib/network call ever happens. <see cref="ITwitchCredentials"/> and
/// <see cref="IAppConfigStore"/> are NSubstitute fakes so every test controls exactly which
/// token/scope path is exercised; time is driven by a manual <see cref="TimeProvider"/> so the
/// 15s/5s caches can be proven without sleeping.
///
/// Most TwitchLib response model properties (<c>User</c>, <c>Stream</c>, <c>ChannelInformation</c>,
/// <c>AdSchedule</c>, <c>Game</c>, <c>BannedUser</c>, ...) have <c>protected</c> setters — they
/// cannot be built with a C# object initializer from outside TwitchLib's own assembly. Fixtures
/// below build them via <see cref="JsonConvert.DeserializeObject{T}(string)"/> instead, using
/// Twitch's real snake_case field names (confirmed via each type's <c>[JsonProperty]</c>
/// attributes during the Phase 2 Task 4 build-time verification pass — see the task report).
/// </summary>
public sealed class HelixClientTests
{
  private static readonly DateTimeOffset Now = new(2026, 7, 17, 12, 0, 0, TimeSpan.Zero);

  private static readonly DomainConfig Config = new()
  {
    TwitchClientId = "the-client-id",
    TwitchChannel = "thechannel",
  };

  private static readonly string[] ThechannelLogin = ["thechannel"];
  private static readonly string[] SomeviewerLogin = ["someviewer"];

  private sealed class ManualTimeProvider(DateTimeOffset now) : TimeProvider
  {
    public DateTimeOffset Now { get; set; } = now;
    public override DateTimeOffset GetUtcNow() => Now;
  }

  private sealed record Fixture(
    HelixClient Client,
    IHelixApi HelixApi,
    ITwitchCredentials Credentials,
    IAppConfigStore AppConfigStore,
    ManualTimeProvider TimeProvider);

  private static Fixture Build(DomainConfig? config = null)
  {
    var helixApi = Substitute.For<IHelixApi>();
    var credentials = Substitute.For<ITwitchCredentials>();
    var appConfigStore = Substitute.For<IAppConfigStore>();
    _ = appConfigStore.GetAsync(Arg.Any<CancellationToken>()).Returns(Result.Ok(config ?? Config));
    var timeProvider = new ManualTimeProvider(Now);
    var client = new HelixClient(helixApi, credentials, appConfigStore, timeProvider);

    return new Fixture(client, helixApi, credentials, appConfigStore, timeProvider);
  }

  private static void SetupActionCredentials(
    ITwitchCredentials credentials, string accessToken = "broadcaster-token", string broadcasterId = "bid-1") =>
    credentials.GetActionCredentialsAsync(Arg.Any<IReadOnlyList<string>>(), Arg.Any<CancellationToken>())
      .Returns(Result.Ok(new TwitchActionCredentials { ClientId = "the-client-id", AccessToken = accessToken, BroadcasterId = broadcasterId }));

  // ---------------------------------------------------------------------
  // TwitchLib response fixture builders (JSON round-trip — see class doc comment)
  // ---------------------------------------------------------------------

  private static T FromJson<T>(object shape) => JsonConvert.DeserializeObject<T>(JsonConvert.SerializeObject(shape))!;

  private static GetUsersResponse UsersResponse(params (string Id, string Login)[] users) =>
    FromJson<GetUsersResponse>(new { data = users.Select(u => new { id = u.Id, login = u.Login }) });

  private static GetChannelInformationResponse ChannelInfoResponse(
    string broadcasterName, string gameId, string gameName, string title, string[] tags) =>
    FromJson<GetChannelInformationResponse>(new
    {
      data = new[] { new { broadcaster_name = broadcasterName, game_id = gameId, game_name = gameName, title, tags } },
    });

  private static GetStreamsResponse StreamsResponse(params object[] streams) =>
    FromJson<GetStreamsResponse>(new { data = streams });

  private static GetAdScheduleResponse AdScheduleResponse(object data) =>
    FromJson<GetAdScheduleResponse>(new { data = new[] { data } });

  private static SearchCategoriesResponse SearchCategoriesResponseOf(params object[] games) =>
    FromJson<SearchCategoriesResponse>(new { data = games });

  private static GetGamesResponse GamesResponse(params object[] games) =>
    FromJson<GetGamesResponse>(new { data = games });

  private static StartCommercialResponse CommercialResponse(int length, string? message, int? retryAfter) =>
    FromJson<StartCommercialResponse>(new { length, message, retry_after = retryAfter ?? 0 });

  private static SendChatMessageResponse ChatResponse(string? messageId, bool isSent, object? dropReason = null) =>
    FromJson<SendChatMessageResponse>(new { data = new[] { new { message_id = messageId, is_sent = isSent, drop_reason = dropReason } } });

  private static BanUserResponse EmptyBanResponse() => FromJson<BanUserResponse>(new { data = Array.Empty<object>() });

  private static CreateEventSubSubscriptionResponse CreateEventSubSubscriptionResponseOf() =>
    FromJson<CreateEventSubSubscriptionResponse>(new { data = Array.Empty<object>(), total = 1, total_cost = 1, max_total_cost = 10 });

  // ---------------------------------------------------------------------
  // GetAuthenticatedUserAsync
  // ---------------------------------------------------------------------

  [Fact]
  public async Task GetAuthenticatedUserResolvesSelfViaProviderToken()
  {
    var f = Build();
    _ = f.Credentials.GetAccessTokenAsync(TwitchProvider.Bot, Arg.Any<CancellationToken>()).Returns(Result.Ok("bot-token"));
    _ = f.HelixApi.GetUsersAsync(null, "bot-token", Arg.Any<CancellationToken>()).Returns(UsersResponse(("u1", "the_bot")));

    var result = await f.Client.GetAuthenticatedUserAsync(TwitchProvider.Bot, CancellationToken.None);

    Assert.True(result.IsSuccess);
    Assert.Equal("u1", result.Value.Id);
    Assert.Equal("the_bot", result.Value.Login);
  }

  // ---------------------------------------------------------------------
  // GetBroadcasterIdAsync (== IBroadcasterIdResolver.GetBroadcasterIdAsync)
  // ---------------------------------------------------------------------

  [Fact]
  public async Task GetBroadcasterIdResolvesByChannelLoginAndCachesAcrossCallsAndTheResolverInterface()
  {
    var f = Build();
    _ = f.Credentials.GetAccessTokenAsync(TwitchProvider.Broadcaster, Arg.Any<CancellationToken>()).Returns(Result.Ok("broadcaster-token"));
    _ = f.HelixApi.GetUsersAsync(
        Arg.Is<IReadOnlyList<string>>(l => l.SequenceEqual(ThechannelLogin)), "broadcaster-token", Arg.Any<CancellationToken>())
      .Returns(UsersResponse(("bid-1", "thechannel")));

    // HelixClient : IHelixClient, IBroadcasterIdResolver with no explicit interface member —
    // f.Client.GetBroadcasterIdAsync IS IBroadcasterIdResolver.GetBroadcasterIdAsync, the same
    // method with the same field cache (enforced at compile time by the class declaration).
    var resolver = Assert.IsType<IBroadcasterIdResolver>(f.Client, exactMatch: false);
    var first = await f.Client.GetBroadcasterIdAsync(CancellationToken.None);
    var second = await resolver.GetBroadcasterIdAsync(CancellationToken.None);

    Assert.True(first.IsSuccess);
    Assert.Equal("bid-1", first.Value);
    Assert.Equal("bid-1", second.Value);

    _ = await f.HelixApi.Received(1).GetUsersAsync(Arg.Any<IReadOnlyList<string>>(), Arg.Any<string>(), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task GetBroadcasterIdFallsBackToAppTokenWhenNoBroadcasterTokenIsConnected()
  {
    var f = Build();
    _ = f.Credentials.GetAccessTokenAsync(TwitchProvider.Broadcaster, Arg.Any<CancellationToken>())
      .Returns(Result.Fail<string>("No stored Twitch Broadcaster token."));
    _ = f.Credentials.GetAppAccessTokenAsync(Arg.Any<CancellationToken>()).Returns(Result.Ok("app-token"));
    _ = f.HelixApi.GetUsersAsync(Arg.Any<IReadOnlyList<string>>(), "app-token", Arg.Any<CancellationToken>())
      .Returns(UsersResponse(("bid-1", "thechannel")));

    var result = await f.Client.GetBroadcasterIdAsync(CancellationToken.None);

    Assert.True(result.IsSuccess);
    Assert.Equal("bid-1", result.Value);
  }

  // ---------------------------------------------------------------------
  // ResolveUserIdAsync
  // ---------------------------------------------------------------------

  [Fact]
  public async Task ResolveUserIdReturnsIdForAKnownLogin()
  {
    var f = Build();
    SetupActionCredentials(f.Credentials);
    _ = f.HelixApi.GetUsersAsync(
        Arg.Is<IReadOnlyList<string>>(l => l.SequenceEqual(SomeviewerLogin)), "broadcaster-token", Arg.Any<CancellationToken>())
      .Returns(UsersResponse(("u-42", "someviewer")));

    var result = await f.Client.ResolveUserIdAsync("@SomeViewer", CancellationToken.None);

    Assert.True(result.IsSuccess);
    Assert.Equal("u-42", result.Value);
  }

  [Fact]
  public async Task ResolveUserIdFailsWithNotFoundOnAnEmptyResultSet()
  {
    var f = Build();
    SetupActionCredentials(f.Credentials);
    _ = f.HelixApi.GetUsersAsync(Arg.Any<IReadOnlyList<string>>(), Arg.Any<string>(), Arg.Any<CancellationToken>())
      .Returns(UsersResponse());

    var result = await f.Client.ResolveUserIdAsync("ghost", CancellationToken.None);

    Assert.True(result.IsFailed);
    Assert.Contains(result.Errors, e => e.Message.Contains("not found", StringComparison.OrdinalIgnoreCase));
  }

  [Fact]
  public async Task ResolveUserIdFailsWithNotFoundOnABadResourceException()
  {
    var f = Build();
    SetupActionCredentials(f.Credentials);
    _ = f.HelixApi.GetUsersAsync(Arg.Any<IReadOnlyList<string>>(), Arg.Any<string>(), Arg.Any<CancellationToken>())
      .Returns<GetUsersResponse>(_ => throw new BadResourceException("no such user", null!));

    var result = await f.Client.ResolveUserIdAsync("ghost", CancellationToken.None);

    Assert.True(result.IsFailed);
    Assert.Contains(result.Errors, e => e.Message.Contains("not found", StringComparison.OrdinalIgnoreCase));
  }

  // ---------------------------------------------------------------------
  // GetChannelInfoAsync / UpdateChannelInfoAsync
  // ---------------------------------------------------------------------

  [Fact]
  public async Task GetChannelInfoParsesAllFields()
  {
    var f = Build();
    SetupActionCredentials(f.Credentials, broadcasterId: "bid-1");
    _ = f.HelixApi.GetChannelInformationAsync("bid-1", "broadcaster-token", Arg.Any<CancellationToken>())
      .Returns(ChannelInfoResponse("TheChannel", "509658", "Just Chatting", "hello", ["English", "Cozy"]));

    var result = await f.Client.GetChannelInfoAsync(CancellationToken.None);

    Assert.True(result.IsSuccess);
    Assert.Equal("TheChannel", result.Value.BroadcasterName);
    Assert.Equal("509658", result.Value.GameId);
    Assert.Equal("Just Chatting", result.Value.GameName);
    Assert.Equal("hello", result.Value.Title);
    Assert.Equal(["English", "Cozy"], result.Value.Tags);
  }

  [Fact]
  public async Task UpdateChannelInfoSendsTheRequestAndRequiresBroadcastScope()
  {
    var f = Build();
    SetupActionCredentials(f.Credentials, broadcasterId: "bid-1");
    _ = f.HelixApi.ModifyChannelInformationAsync(
        "bid-1", Arg.Any<ModifyChannelInformationRequest>(), "broadcaster-token", Arg.Any<CancellationToken>())
      .Returns(true);

    var result = await f.Client.UpdateChannelInfoAsync("new title", "509658", ["English"], CancellationToken.None);

    Assert.True(result.IsSuccess);
    _ = await f.HelixApi.Received(1).ModifyChannelInformationAsync(
      "bid-1",
      Arg.Is<ModifyChannelInformationRequest>(r => r.Title == "new title" && r.GameId == "509658" && r.Tags!.SequenceEqual(new[] { "English" })),
      "broadcaster-token",
      Arg.Any<CancellationToken>());
    _ = await f.Credentials.Received(1).GetActionCredentialsAsync(
      Arg.Is<IReadOnlyList<string>>(s => s.Contains("channel:manage:broadcast")), Arg.Any<CancellationToken>());
  }

  // ---------------------------------------------------------------------
  // GetStreamStatusAsync — 15s cache
  // ---------------------------------------------------------------------

  [Fact]
  public async Task GetStreamStatusCachesForFifteenSecondsThenRefetches()
  {
    var f = Build();
    _ = f.Credentials.GetAccessTokenAsync(TwitchProvider.Broadcaster, Arg.Any<CancellationToken>()).Returns(Result.Ok("broadcaster-token"));
    _ = f.HelixApi.GetStreamsAsync(Arg.Any<IReadOnlyList<string>>(), "broadcaster-token", Arg.Any<CancellationToken>())
      .Returns(StreamsResponse(new { started_at = "2026-07-17T10:00:00Z", viewer_count = 42 }));

    var first = await f.Client.GetStreamStatusAsync(CancellationToken.None);
    var second = await f.Client.GetStreamStatusAsync(CancellationToken.None);
    Assert.True(first.IsSuccess);
    Assert.Equal(42, first.Value.ViewerCount);
    Assert.Equal(first.Value.StartedAt, second.Value.StartedAt);
    _ = await f.HelixApi.Received(1).GetStreamsAsync(Arg.Any<IReadOnlyList<string>>(), Arg.Any<string>(), Arg.Any<CancellationToken>());

    f.TimeProvider.Now = Now + TimeSpan.FromSeconds(16);
    var third = await f.Client.GetStreamStatusAsync(CancellationToken.None);
    Assert.True(third.IsSuccess);
    _ = await f.HelixApi.Received(2).GetStreamsAsync(Arg.Any<IReadOnlyList<string>>(), Arg.Any<string>(), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task GetStreamStatusReturnsOfflineWhenNoStreamIsLive()
  {
    var f = Build();
    _ = f.Credentials.GetAccessTokenAsync(TwitchProvider.Broadcaster, Arg.Any<CancellationToken>()).Returns(Result.Ok("broadcaster-token"));
    _ = f.HelixApi.GetStreamsAsync(Arg.Any<IReadOnlyList<string>>(), Arg.Any<string>(), Arg.Any<CancellationToken>())
      .Returns(StreamsResponse());

    var result = await f.Client.GetStreamStatusAsync(CancellationToken.None);

    Assert.True(result.IsSuccess);
    Assert.Null(result.Value.StartedAt);
    Assert.Null(result.Value.ViewerCount);
  }

  // ---------------------------------------------------------------------
  // GetAdScheduleAsync — 5s cache
  // ---------------------------------------------------------------------

  [Fact]
  public async Task GetAdScheduleCachesForFiveSecondsThenRefetches()
  {
    var f = Build();
    SetupActionCredentials(f.Credentials);
    _ = f.HelixApi.GetAdScheduleAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<CancellationToken>())
      .Returns(AdScheduleResponse(new
      {
        next_ad_at = "2026-07-17T12:30:00Z",
        duration = 90,
        preroll_free_time = 600,
        snooze_count = 3,
        snooze_refresh_at = "2026-07-18T00:00:00Z",
      }));

    var first = await f.Client.GetAdScheduleAsync(CancellationToken.None);
    var second = await f.Client.GetAdScheduleAsync(CancellationToken.None);
    Assert.True(first.IsSuccess);
    Assert.Equal(90, first.Value.Duration);
    Assert.Equal(3, first.Value.SnoozeCount);
    Assert.Equal(new DateTimeOffset(2026, 7, 17, 12, 30, 0, TimeSpan.Zero), first.Value.NextAdAt);
    Assert.Equal(first.Value.NextAdAt, second.Value.NextAdAt);
    _ = await f.HelixApi.Received(1).GetAdScheduleAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<CancellationToken>());

    f.TimeProvider.Now = Now + TimeSpan.FromSeconds(6);
    var third = await f.Client.GetAdScheduleAsync(CancellationToken.None);
    Assert.True(third.IsSuccess);
    _ = await f.HelixApi.Received(2).GetAdScheduleAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<CancellationToken>());

    _ = await f.Credentials.Received().GetActionCredentialsAsync(
      Arg.Is<IReadOnlyList<string>>(s => s.Contains("channel:read:ads")), Arg.Any<CancellationToken>());
  }

  // ---------------------------------------------------------------------
  // SearchCategoriesAsync / GetGameByIdAsync
  // ---------------------------------------------------------------------

  [Fact]
  public async Task SearchCategoriesUrlEncodesTheQueryAndMapsResults()
  {
    var f = Build();
    _ = f.Credentials.GetAccessTokenAsync(TwitchProvider.Broadcaster, Arg.Any<CancellationToken>()).Returns(Result.Ok("broadcaster-token"));
    _ = f.HelixApi.SearchCategoriesAsync("cozy%20games", "broadcaster-token", Arg.Any<CancellationToken>())
      .Returns(SearchCategoriesResponseOf(
        new { id = "1", name = "Cozy Games", box_art_url = "https://example/1.jpg" },
        new { id = "2", name = "Cozy Grove", box_art_url = (string?)null }));

    var result = await f.Client.SearchCategoriesAsync("cozy games", CancellationToken.None);

    Assert.True(result.IsSuccess);
    Assert.Equal(2, result.Value.Count);
    Assert.Equal("Cozy Games", result.Value[0].Name);
    Assert.Null(result.Value[1].BoxArtUrl);
  }

  [Fact]
  public async Task GetGameByIdReturnsNullWhenTwitchNoLongerKnowsTheGame()
  {
    var f = Build();
    _ = f.Credentials.GetAccessTokenAsync(TwitchProvider.Broadcaster, Arg.Any<CancellationToken>()).Returns(Result.Ok("broadcaster-token"));
    _ = f.HelixApi.GetGamesAsync(Arg.Any<IReadOnlyList<string>>(), Arg.Any<string>(), Arg.Any<CancellationToken>())
      .Returns(GamesResponse());

    var result = await f.Client.GetGameByIdAsync("999999", CancellationToken.None);

    Assert.True(result.IsSuccess);
    Assert.Null(result.Value);
  }

  // ---------------------------------------------------------------------
  // RunCommercialAsync — single-flight dedup
  // ---------------------------------------------------------------------

  [Fact]
  public async Task RunCommercialSingleFlightsConcurrentCallsIntoOneHelixCall()
  {
    var f = Build();
    SetupActionCredentials(f.Credentials);
    var gate = new TaskCompletionSource();
    var callCount = 0;

    async Task<StartCommercialResponse> GatedResponse()
    {
      _ = Interlocked.Increment(ref callCount);
      await gate.Task;
      return CommercialResponse(180, null, null);
    }

    _ = f.HelixApi.StartCommercialAsync(Arg.Any<StartCommercialRequest>(), Arg.Any<string>(), Arg.Any<CancellationToken>())
      .Returns(_ => GatedResponse());

    var task1 = f.Client.RunCommercialAsync(180, CancellationToken.None);
    var task2 = f.Client.RunCommercialAsync(180, CancellationToken.None);
    await Task.Delay(50); // give both callers a chance to reach the blocked handler
    gate.SetResult();

    var result1 = await task1;
    var result2 = await task2;

    Assert.True(result1.IsSuccess);
    Assert.True(result2.IsSuccess);
    Assert.Equal(180, result1.Value.Length);
    Assert.Equal(1, callCount);

    // A call made AFTER the first has completed starts a fresh request.
    var result3 = await f.Client.RunCommercialAsync(180, CancellationToken.None);
    Assert.True(result3.IsSuccess);
    Assert.Equal(2, callCount);
  }

  // ---------------------------------------------------------------------
  // SendChatMessageAsync
  // ---------------------------------------------------------------------

  [Fact]
  public async Task SendChatMessageAsBroadcasterUsesTheBroadcasterTokenAndOwnIdAsSender()
  {
    var f = Build();
    SetupActionCredentials(f.Credentials, accessToken: "broadcaster-token", broadcasterId: "bid-1");
    _ = f.HelixApi.SendChatMessageAsync("bid-1", "bid-1", "hello chat", null, "broadcaster-token", Arg.Any<CancellationToken>())
      .Returns(ChatResponse("msg-1", isSent: true));

    var result = await f.Client.SendChatMessageAsync(TwitchProvider.Broadcaster, "hello chat", cancellationToken: CancellationToken.None);

    Assert.True(result.IsSuccess);
    Assert.Equal("msg-1", result.Value);

    _ = await f.Credentials.Received(1).GetActionCredentialsAsync(
      Arg.Is<IReadOnlyList<string>>(s => s.Contains("user:write:chat")), Arg.Any<CancellationToken>());
    _ = await f.Credentials.DidNotReceive().GetAccessTokenAsync(TwitchProvider.Bot, Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task SendChatMessageAsBotResolvesAndCachesItsOwnUserIdAndUsesTheBotToken()
  {
    var f = Build();
    _ = f.Credentials.GetAccessTokenAsync(TwitchProvider.Bot, Arg.Any<CancellationToken>()).Returns(Result.Ok("bot-token"));
    _ = f.Credentials.GetAccessTokenAsync(TwitchProvider.Broadcaster, Arg.Any<CancellationToken>()).Returns(Result.Ok("broadcaster-token"));
    _ = f.HelixApi.GetUsersAsync(null, "bot-token", Arg.Any<CancellationToken>()).Returns(UsersResponse(("bot-uid", "the_bot")));
    _ = f.HelixApi.GetUsersAsync(Arg.Is<IReadOnlyList<string>>(l => l.SequenceEqual(ThechannelLogin)), "broadcaster-token", Arg.Any<CancellationToken>())
      .Returns(UsersResponse(("bid-1", "thechannel")));
    // NSubstitute requires EVERY argument of a repeated type (five string-typed parameters
    // here) to use a matcher once any one of them does — mixing literals with Arg.* for the
    // same type throws AmbiguousArgumentsException, hence Arg.Is<string>(s => s == "...") for
    // the ones with a fixed expected value rather than plain string literals.
    _ = f.HelixApi.SendChatMessageAsync(
        Arg.Is<string>(s => s == "bid-1"), Arg.Is<string>(s => s == "bot-uid"), Arg.Any<string>(), Arg.Any<string?>(),
        Arg.Is<string>(s => s == "bot-token"), Arg.Any<CancellationToken>())
      .Returns(ChatResponse("msg-2", isSent: true));

    var first = await f.Client.SendChatMessageAsync(TwitchProvider.Bot, "quack", cancellationToken: CancellationToken.None);
    var second = await f.Client.SendChatMessageAsync(TwitchProvider.Bot, "quack again", cancellationToken: CancellationToken.None);

    Assert.True(first.IsSuccess);
    Assert.True(second.IsSuccess);

    // Bot's own id (self-lookup GetUsersAsync) is resolved once and cached across both sends.
    _ = await f.HelixApi.Received(1).GetUsersAsync(null, "bot-token", Arg.Any<CancellationToken>());
    _ = await f.HelixApi.Received(2).SendChatMessageAsync(
      Arg.Is<string>(s => s == "bid-1"), Arg.Is<string>(s => s == "bot-uid"), Arg.Any<string>(), Arg.Any<string?>(),
      Arg.Is<string>(s => s == "bot-token"), Arg.Any<CancellationToken>());
    _ = await f.Credentials.DidNotReceive().GetActionCredentialsAsync(
      Arg.Is<IReadOnlyList<string>>(s => s.Contains("user:write:chat")), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task SendChatMessageFailsWhenTwitchDropsTheMessage()
  {
    var f = Build();
    SetupActionCredentials(f.Credentials);
    _ = f.HelixApi.SendChatMessageAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<string>(), Arg.Any<string?>(), Arg.Any<string>(), Arg.Any<CancellationToken>())
      .Returns(ChatResponse(null, isSent: false, dropReason: new { code = "automod_message_rejected", message = "Message rejected by AutoMod." }));

    var result = await f.Client.SendChatMessageAsync(TwitchProvider.Broadcaster, "bad word", cancellationToken: CancellationToken.None);

    Assert.True(result.IsFailed);
    Assert.Contains(result.Errors, e => e.Message == "Message rejected by AutoMod.");
  }

  // ---------------------------------------------------------------------
  // SendShoutoutAsync / SendWhisperAsync
  // ---------------------------------------------------------------------

  [Fact]
  public async Task SendShoutoutUsesTheBroadcasterIdForFromAndModeratorAndTheTargetForTo()
  {
    var f = Build();
    SetupActionCredentials(f.Credentials, broadcasterId: "bid-1");
    _ = f.HelixApi.SendShoutoutAsync("bid-1", "target-99", "bid-1", "broadcaster-token", Arg.Any<CancellationToken>())
      .Returns(Task.CompletedTask);

    var result = await f.Client.SendShoutoutAsync("target-99", CancellationToken.None);

    Assert.True(result.IsSuccess);
    _ = await f.Credentials.Received(1).GetActionCredentialsAsync(
      Arg.Is<IReadOnlyList<string>>(s => s.Contains("moderator:manage:shoutouts")), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task SendWhisperCapsMessageAtFiveHundredCharactersAndAlwaysPassesNewRecipientTrue()
  {
    var f = Build();
    SetupActionCredentials(f.Credentials, broadcasterId: "bid-1");
    var longMessage = new string('x', 600);
    string? sentMessage = null;
    _ = f.HelixApi.SendWhisperAsync("bid-1", "target-99", Arg.Do<string>(m => sentMessage = m), true, "broadcaster-token", Arg.Any<CancellationToken>())
      .Returns(Task.CompletedTask);

    var result = await f.Client.SendWhisperAsync("target-99", longMessage, CancellationToken.None);

    Assert.True(result.IsSuccess);
    Assert.Equal(500, sentMessage!.Length);
  }

  // ---------------------------------------------------------------------
  // BanOrTimeoutAsync
  // ---------------------------------------------------------------------

  [Fact]
  public async Task BanOrTimeoutSendsDurationForATimeout()
  {
    var f = Build();
    SetupActionCredentials(f.Credentials, broadcasterId: "bid-1");
    _ = f.HelixApi.BanUserAsync("bid-1", "bid-1", Arg.Any<BanUserRequest>(), "broadcaster-token", Arg.Any<CancellationToken>())
      .Returns(EmptyBanResponse());

    var result = await f.Client.BanOrTimeoutAsync("target-99", 300, "spam", CancellationToken.None);

    Assert.True(result.IsSuccess);
    _ = await f.HelixApi.Received(1).BanUserAsync(
      "bid-1", "bid-1", Arg.Is<BanUserRequest>(r => r.UserId == "target-99" && r.Duration == 300 && r.Reason == "spam"),
      "broadcaster-token", Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task BanOrTimeoutOmitsDurationForAPermanentBan()
  {
    var f = Build();
    SetupActionCredentials(f.Credentials, broadcasterId: "bid-1");
    _ = f.HelixApi.BanUserAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<BanUserRequest>(), Arg.Any<string>(), Arg.Any<CancellationToken>())
      .Returns(EmptyBanResponse());

    var result = await f.Client.BanOrTimeoutAsync("target-99", null, null, CancellationToken.None);

    Assert.True(result.IsSuccess);
    _ = await f.HelixApi.Received(1).BanUserAsync(
      Arg.Any<string>(), Arg.Any<string>(), Arg.Is<BanUserRequest>(r => r.UserId == "target-99" && r.Duration == null && r.Reason == null),
      Arg.Any<string>(), Arg.Any<CancellationToken>());
  }

  // ---------------------------------------------------------------------
  // ResolveAutomodMessageAsync
  // ---------------------------------------------------------------------

  [Fact]
  public async Task ResolveAutomodMessageResolvesOkOnSuccess()
  {
    var f = Build();
    SetupActionCredentials(f.Credentials, broadcasterId: "bid-1");
    _ = f.HelixApi.ManageHeldAutoModMessagesAsync("bid-1", "msg-1", ManageHeldAutoModMessageActionEnum.ALLOW, "broadcaster-token", Arg.Any<CancellationToken>())
      .Returns(Task.CompletedTask);

    var result = await f.Client.ResolveAutomodMessageAsync("msg-1", allow: true, CancellationToken.None);

    Assert.True(result.IsSuccess);
    Assert.Equal(AutomodOutcomes.Ok, result.Value.Outcome);
  }

  [Fact]
  public async Task ResolveAutomodMessageResolvesGoneOnABadResourceExceptionRatherThanFailing()
  {
    var f = Build();
    SetupActionCredentials(f.Credentials);
    _ = f.HelixApi.ManageHeldAutoModMessagesAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<ManageHeldAutoModMessageActionEnum>(), Arg.Any<string>(), Arg.Any<CancellationToken>())
      .Returns(_ => throw new BadResourceException("already resolved", null!));

    var result = await f.Client.ResolveAutomodMessageAsync("msg-1", allow: false, CancellationToken.None);

    Assert.True(result.IsSuccess);
    Assert.Equal(AutomodOutcomes.Gone, result.Value.Outcome);
  }

  [Fact]
  public async Task ResolveAutomodMessageFailsOnARealError()
  {
    var f = Build();
    SetupActionCredentials(f.Credentials);
    _ = f.HelixApi.ManageHeldAutoModMessagesAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<ManageHeldAutoModMessageActionEnum>(), Arg.Any<string>(), Arg.Any<CancellationToken>())
      .Returns(_ => throw new TokenExpiredException("Invalid OAuth token", null!));

    var result = await f.Client.ResolveAutomodMessageAsync("msg-1", allow: false, CancellationToken.None);

    Assert.True(result.IsFailed);
    Assert.Contains(result.Errors, e => e.Message.Contains("Invalid OAuth token", StringComparison.Ordinal));
  }

  // ---------------------------------------------------------------------
  // CreateEventSubWebsocketSubscriptionAsync (Phase 2 Task 5 fix pass) — a FRESH broadcaster
  // token every call (never the cached GetBroadcasterIdAsync path), routed through IHelixApi
  // so TwitchLibHelixApi's per-call Settings.ClientId sync always runs, even on a resubscribe
  // long after the first connect.
  // ---------------------------------------------------------------------

  [Fact]
  public async Task CreateEventSubWebsocketSubscriptionPassesTypeVersionConditionAndSessionIdWithAFreshToken()
  {
    var f = Build();
    _ = f.Credentials.GetAccessTokenAsync(TwitchProvider.Broadcaster, Arg.Any<CancellationToken>()).Returns(Result.Ok("broadcaster-token"));
    _ = f.HelixApi.CreateEventSubSubscriptionAsync(
        "channel.chat.message", "1", Arg.Any<Dictionary<string, string>>(), "session-1", "broadcaster-token", Arg.Any<CancellationToken>())
      .Returns(CreateEventSubSubscriptionResponseOf());

    var condition = new Dictionary<string, string> { ["broadcaster_user_id"] = "bid-1", ["user_id"] = "bid-1" };
    var result = await f.Client.CreateEventSubWebsocketSubscriptionAsync("channel.chat.message", "1", condition, "session-1", CancellationToken.None);

    Assert.True(result.IsSuccess);
    _ = await f.HelixApi.Received(1).CreateEventSubSubscriptionAsync(
      "channel.chat.message",
      "1",
      Arg.Is<Dictionary<string, string>>(c => c["broadcaster_user_id"] == "bid-1" && c["user_id"] == "bid-1"),
      "session-1",
      "broadcaster-token",
      Arg.Any<CancellationToken>());

    // Never the cached broadcaster-id/token resolution path other methods share.
    _ = await f.Credentials.DidNotReceive().GetActionCredentialsAsync(Arg.Any<IReadOnlyList<string>>(), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task CreateEventSubWebsocketSubscriptionFailsWhenNoBroadcasterTokenIsAvailable()
  {
    var f = Build();
    _ = f.Credentials.GetAccessTokenAsync(TwitchProvider.Broadcaster, Arg.Any<CancellationToken>())
      .Returns(Result.Fail<string>("No stored Twitch Broadcaster token."));

    var result = await f.Client.CreateEventSubWebsocketSubscriptionAsync(
      "channel.chat.message", "1", new Dictionary<string, string>(), "session-1", CancellationToken.None);

    Assert.True(result.IsFailed);
    _ = await f.HelixApi.DidNotReceive().CreateEventSubSubscriptionAsync(
      Arg.Any<string>(), Arg.Any<string>(), Arg.Any<Dictionary<string, string>>(), Arg.Any<string>(), Arg.Any<string>(), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task CreateEventSubWebsocketSubscriptionMapsAThrownTwitchLibExceptionToResultFail()
  {
    var f = Build();
    _ = f.Credentials.GetAccessTokenAsync(TwitchProvider.Broadcaster, Arg.Any<CancellationToken>()).Returns(Result.Ok("broadcaster-token"));
    _ = f.HelixApi.CreateEventSubSubscriptionAsync(
        Arg.Any<string>(), Arg.Any<string>(), Arg.Any<Dictionary<string, string>>(), Arg.Any<string>(), Arg.Any<string>(), Arg.Any<CancellationToken>())
      .Returns<CreateEventSubSubscriptionResponse>(_ => throw new BadScopeException("missing user:read:chat", null!));

    var result = await f.Client.CreateEventSubWebsocketSubscriptionAsync(
      "channel.chat.message", "1", new Dictionary<string, string> { ["broadcaster_user_id"] = "bid-1" }, "session-1", CancellationToken.None);

    Assert.True(result.IsFailed);
    Assert.Contains(result.Errors, e => e.Message.Contains("reconnect", StringComparison.OrdinalIgnoreCase));
  }

  // ---------------------------------------------------------------------
  // Error mapping (twitchlib-spec.md §2.4) — none of these throw out of HelixClient; each
  // reaching a Result.Fail assertion below (rather than an unhandled exception) IS the proof.
  // ---------------------------------------------------------------------

  [Fact]
  public async Task TokenExpiredExceptionMapsToAReAuthFailure()
  {
    var f = Build();
    SetupActionCredentials(f.Credentials);
    _ = f.HelixApi.GetChannelInformationAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<CancellationToken>())
      .Returns<GetChannelInformationResponse>(_ => throw new TokenExpiredException("token expired", null!));

    var result = await f.Client.GetChannelInfoAsync(CancellationToken.None);

    Assert.True(result.IsFailed);
    Assert.Contains(result.Errors, e => e.Message.Contains("reconnect", StringComparison.OrdinalIgnoreCase));
  }

  [Fact]
  public async Task TooManyRequestsExceptionMapsToABackoffFailure()
  {
    var f = Build();
    SetupActionCredentials(f.Credentials);
    _ = f.HelixApi.GetChannelInformationAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<CancellationToken>())
      .Returns<GetChannelInformationResponse>(_ => throw new TooManyRequestsException("slow down", "60", null!));

    var result = await f.Client.GetChannelInfoAsync(CancellationToken.None);

    Assert.True(result.IsFailed);
    Assert.Contains(result.Errors, e => e.Message.Contains("rate-limiting", StringComparison.OrdinalIgnoreCase));
  }

  [Fact]
  public async Task BadResourceExceptionMapsToANotFoundFailureOnAGenericCall()
  {
    var f = Build();
    SetupActionCredentials(f.Credentials);
    _ = f.HelixApi.GetChannelInformationAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<CancellationToken>())
      .Returns<GetChannelInformationResponse>(_ => throw new BadResourceException("no such channel", null!));

    var result = await f.Client.GetChannelInfoAsync(CancellationToken.None);

    Assert.True(result.IsFailed);
    Assert.Contains(result.Errors, e => e.Message.Contains("not find", StringComparison.OrdinalIgnoreCase));
  }

  [Fact]
  public async Task PlainHttpRequestExceptionMapsToAGenericFailure()
  {
    var f = Build();
    SetupActionCredentials(f.Credentials);
    _ = f.HelixApi.GetChannelInformationAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<CancellationToken>())
      .Returns<GetChannelInformationResponse>(_ => throw new HttpRequestException("Unprocessable Entity", null, System.Net.HttpStatusCode.UnprocessableEntity));

    var result = await f.Client.GetChannelInfoAsync(CancellationToken.None);

    Assert.True(result.IsFailed);
    Assert.Contains(result.Errors, e => e.Message.Contains("Unprocessable Entity", StringComparison.Ordinal));
  }
}
