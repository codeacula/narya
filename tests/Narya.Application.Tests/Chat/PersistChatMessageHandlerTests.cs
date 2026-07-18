using FluentResults;

using MediatR;

using NSubstitute;

using Narya.Application.Chat;
using Narya.Core.AppConfig;
using Narya.Core.Chat;
using Narya.Core.Sessions;

using DomainConfig = Narya.Domain.AppConfig.AppConfig;

namespace Narya.Application.Tests.Chat;

public sealed class PersistChatMessageHandlerTests
{
  private sealed record Fixture(
    IChatStore ChatStore, IStreamSessionStore SessionStore, IAppConfigStore AppConfigStore, IMediator Mediator, PersistChatMessageHandler Handler);

  private static Fixture Build(string twitchChannel = "codeacula")
  {
    var chatStore = Substitute.For<IChatStore>();
    var sessionStore = Substitute.For<IStreamSessionStore>();
    var appConfigStore = Substitute.For<IAppConfigStore>();
    var mediator = Substitute.For<IMediator>();

    _ = appConfigStore.GetAsync(Arg.Any<CancellationToken>())
      .Returns(Result.Ok(new DomainConfig { TwitchChannel = twitchChannel }));
    _ = chatStore.TryInsertMessageAsync(Arg.Any<ChatMessage>(), Arg.Any<CancellationToken>()).Returns(true);
    _ = sessionStore.GetCurrentSessionIdAsync(Arg.Any<CancellationToken>()).Returns((string?)null);
    _ = sessionStore.RecordCurrentSessionChatterAsync(
        Arg.Any<string>(), Arg.Any<string>(), Arg.Any<DateTimeOffset>(), Arg.Any<CancellationToken>())
      .Returns(new SessionChatterResult(null, false));

    var handler = new PersistChatMessageHandler(chatStore, sessionStore, appConfigStore, mediator);
    return new Fixture(chatStore, sessionStore, appConfigStore, mediator, handler);
  }

  private static ChatMessage BuildMessage(string username = "viewer", IReadOnlyDictionary<string, string>? badges = null) =>
    new(
      Id: "msg-1",
      Channel: "codeacula",
      Username: username,
      DisplayName: username,
      Color: "#ff0000",
      Message: "hello chat",
      ReceivedAt: DateTimeOffset.UtcNow,
      Badges: badges,
      ChatterUserId: "viewer-id-1");

  [Fact]
  public async Task AlwaysAppendsAChatEventRegardlessOfInsertOutcome()
  {
    var f = Build();
    _ = f.ChatStore.TryInsertMessageAsync(Arg.Any<ChatMessage>(), Arg.Any<CancellationToken>()).Returns(false);

    await f.Handler.Handle(new ChatMessageIngestedNotification(BuildMessage()), CancellationToken.None);

    _ = await f.ChatStore.Received(1).AppendChatEventAsync(
      "message.created", "codeacula", Arg.Any<string>(), "msg-1", "viewer", Arg.Any<DateTimeOffset>(), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task NewChatterFirstMessageIsPersistedEnrichedAsFirstEverAndBroadcast()
  {
    var f = Build();
    _ = f.ChatStore.HasSeenChatterBeforeAsync("viewer", Arg.Any<CancellationToken>()).Returns(false);

    await f.Handler.Handle(new ChatMessageIngestedNotification(BuildMessage()), CancellationToken.None);

    _ = await f.ChatStore.Received(1).TryInsertMessageAsync(
      Arg.Is<ChatMessage>(m => m.IsFirstEver && m.IsFirstTimer), Arg.Any<CancellationToken>());
    await f.ChatStore.Received(1).UpsertChatterAsync(
      "viewer", Arg.Any<DateTimeOffset>(), "viewer", "#ff0000", null, Arg.Any<CancellationToken>());
    await f.Mediator.Received(1).Publish(
      Arg.Is<ChatMessageBroadcastNotification>(n => n.Message.IsFirstEver), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task RedeliveryStopsBeforeChattersUpsertAndBroadcast()
  {
    var f = Build();
    _ = f.ChatStore.TryInsertMessageAsync(Arg.Any<ChatMessage>(), Arg.Any<CancellationToken>()).Returns(false);

    await f.Handler.Handle(new ChatMessageIngestedNotification(BuildMessage()), CancellationToken.None);

    await f.ChatStore.DidNotReceive().UpsertChatterAsync(
      Arg.Any<string>(), Arg.Any<DateTimeOffset>(), Arg.Any<string>(), Arg.Any<string?>(),
      Arg.Any<IReadOnlyDictionary<string, string>?>(), Arg.Any<CancellationToken>());
    await f.Mediator.DidNotReceive().Publish(Arg.Any<ChatMessageBroadcastNotification>(), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task ReturningChatterIsNotFirstEver()
  {
    var f = Build();
    _ = f.ChatStore.HasSeenChatterBeforeAsync("viewer", Arg.Any<CancellationToken>()).Returns(true);

    await f.Handler.Handle(new ChatMessageIngestedNotification(BuildMessage()), CancellationToken.None);

    _ = await f.ChatStore.Received(1).TryInsertMessageAsync(
      Arg.Is<ChatMessage>(m => !m.IsFirstEver && !m.IsFirstTimer), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task SessionEnrichmentStampsSessionIdAndFirstInSessionFromTheSessionStore()
  {
    var f = Build();
    _ = f.ChatStore.HasSeenChatterBeforeAsync("viewer", Arg.Any<CancellationToken>()).Returns(true);
    _ = f.SessionStore.RecordCurrentSessionChatterAsync(
        "viewer", "msg-1", Arg.Any<DateTimeOffset>(), Arg.Any<CancellationToken>())
      .Returns(new SessionChatterResult("session-1", true));

    await f.Handler.Handle(new ChatMessageIngestedNotification(BuildMessage()), CancellationToken.None);

    _ = await f.ChatStore.Received(1).TryInsertMessageAsync(
      Arg.Is<ChatMessage>(m => m.SessionId == "session-1" && m.IsFirstThisSession), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task BroadcasterMessageByUsernameSkipsSessionChatterTrackingButIsStampedWithTheSessionId()
  {
    var f = Build(twitchChannel: "codeacula");
    _ = f.SessionStore.GetCurrentSessionIdAsync(Arg.Any<CancellationToken>()).Returns("session-1");

    await f.Handler.Handle(new ChatMessageIngestedNotification(BuildMessage(username: "CodeAcula")), CancellationToken.None);

    _ = await f.SessionStore.DidNotReceive().RecordCurrentSessionChatterAsync(
      Arg.Any<string>(), Arg.Any<string>(), Arg.Any<DateTimeOffset>(), Arg.Any<CancellationToken>());
    _ = await f.ChatStore.DidNotReceive().HasSeenChatterBeforeAsync(Arg.Any<string>(), Arg.Any<CancellationToken>());
    _ = await f.ChatStore.Received(1).TryInsertMessageAsync(
      Arg.Is<ChatMessage>(m => m.SessionId == "session-1" && !m.IsFirstThisSession && !m.IsFirstEver),
      Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task BroadcasterMessageByBadgeIsAlsoTreatedAsChannelOwner()
  {
    var f = Build(twitchChannel: "codeacula");
    _ = f.SessionStore.GetCurrentSessionIdAsync(Arg.Any<CancellationToken>()).Returns("session-1");
    var badges = new Dictionary<string, string> { ["broadcaster"] = "1" };

    await f.Handler.Handle(
      new ChatMessageIngestedNotification(BuildMessage(username: "someoneelse", badges: badges)), CancellationToken.None);

    _ = await f.SessionStore.DidNotReceive().RecordCurrentSessionChatterAsync(
      Arg.Any<string>(), Arg.Any<string>(), Arg.Any<DateTimeOffset>(), Arg.Any<CancellationToken>());
    _ = await f.ChatStore.Received(1).TryInsertMessageAsync(
      Arg.Is<ChatMessage>(m => m.SessionId == "session-1" && !m.IsFirstThisSession && !m.IsFirstEver),
      Arg.Any<CancellationToken>());
  }
}
