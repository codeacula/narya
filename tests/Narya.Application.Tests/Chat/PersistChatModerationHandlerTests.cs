using MediatR;

using NSubstitute;

using Narya.Application.Chat;
using Narya.Core.Chat;

namespace Narya.Application.Tests.Chat;

public sealed class PersistChatModerationHandlerTests
{
  private sealed record Fixture(IChatStore ChatStore, IMediator Mediator, PersistChatModerationHandler Handler);

  private static Fixture Build()
  {
    var chatStore = Substitute.For<IChatStore>();
    var mediator = Substitute.For<IMediator>();

    _ = chatStore.AppendChatEventAsync(
        Arg.Any<string>(), Arg.Any<string>(), Arg.Any<string>(), Arg.Any<string?>(), Arg.Any<string?>(),
        Arg.Any<DateTimeOffset>(), Arg.Any<CancellationToken>())
      .Returns(callInfo => new ChatEventAppendResult(Guid.NewGuid(), callInfo.ArgAt<DateTimeOffset>(5)));

    var handler = new PersistChatModerationHandler(chatStore, mediator);
    return new Fixture(chatStore, mediator, handler);
  }

  [Fact]
  public async Task MessageDeletedAppendsAMessageDeletedEventMarksTheOneMessageAndBroadcastsWithTheLegacyReason()
  {
    var f = Build();
    var moderationEvent = new ChatModerationEvent(
      "message.deleted", "codeacula", MessageId: "msg-1", Username: "spammer",
      DeletedAt: DateTimeOffset.UtcNow, DeletedReason: "raw, unused by the handler");

    await f.Handler.Handle(new ChatModeratedNotification(moderationEvent), CancellationToken.None);

    _ = await f.ChatStore.Received(1).AppendChatEventAsync(
      "message.deleted", "codeacula", Arg.Any<string>(), "msg-1", "spammer", moderationEvent.DeletedAt, Arg.Any<CancellationToken>());
    _ = await f.ChatStore.Received(1).MarkMessageDeletedAsync(
      "msg-1", Arg.Any<DateTimeOffset>(), "message deleted by moderator", Arg.Any<Guid>(), Arg.Any<CancellationToken>());
    await f.Mediator.Received(1).Publish(
      Arg.Is<ChatModeratedBroadcastNotification>(n =>
        n.ModerationEvent.Type == "message.deleted"
        && n.ModerationEvent.MessageId == "msg-1"
        && n.ModerationEvent.DeletedReason == "message deleted by moderator"),
      Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task MessageDeletedWithNoMessageIdSkipsTheStoreCallButStillBroadcasts()
  {
    var f = Build();
    var moderationEvent = new ChatModerationEvent(
      "message.deleted", "codeacula", MessageId: null, Username: null, DateTimeOffset.UtcNow, "unused");

    await f.Handler.Handle(new ChatModeratedNotification(moderationEvent), CancellationToken.None);

    _ = await f.ChatStore.DidNotReceive().MarkMessageDeletedAsync(
      Arg.Any<string>(), Arg.Any<DateTimeOffset>(), Arg.Any<string>(), Arg.Any<Guid>(), Arg.Any<CancellationToken>());
    await f.Mediator.Received(1).Publish(Arg.Any<ChatModeratedBroadcastNotification>(), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task UserTimeoutMarksAllThatUsersMessagesAndBroadcastsWithTheNoReasonFallback()
  {
    var f = Build();
    var moderationEvent = new ChatModerationEvent(
      "user.timeout", "codeacula", MessageId: null, Username: "rowdyviewer", DateTimeOffset.UtcNow, "unused");

    await f.Handler.Handle(new ChatModeratedNotification(moderationEvent), CancellationToken.None);

    await f.ChatStore.Received(1).MarkUserMessagesDeletedAsync(
      "codeacula", "rowdyviewer", Arg.Any<DateTimeOffset>(), "timeout: no reason provided", Arg.Any<Guid>(), Arg.Any<CancellationToken>());
    await f.Mediator.Received(1).Publish(
      Arg.Is<ChatModeratedBroadcastNotification>(n => n.ModerationEvent.DeletedReason == "timeout: no reason provided"),
      Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task UserBanMarksAllThatUsersMessagesAndBroadcastsWithTheBanReason()
  {
    var f = Build();
    var moderationEvent = new ChatModerationEvent(
      "user.ban", "codeacula", MessageId: null, Username: "spammer", DateTimeOffset.UtcNow, "unused");

    await f.Handler.Handle(new ChatModeratedNotification(moderationEvent), CancellationToken.None);

    await f.ChatStore.Received(1).MarkUserMessagesDeletedAsync(
      "codeacula", "spammer", Arg.Any<DateTimeOffset>(), "ban: no reason provided", Arg.Any<Guid>(), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task ChatClearMarksAllChannelMessagesAndBroadcastsWithTheChatClearedReason()
  {
    var f = Build();
    var moderationEvent = new ChatModerationEvent(
      "chat.clear", "codeacula", MessageId: null, Username: null, DateTimeOffset.UtcNow, "unused");

    await f.Handler.Handle(new ChatModeratedNotification(moderationEvent), CancellationToken.None);

    await f.ChatStore.Received(1).MarkChannelMessagesDeletedAsync(
      "codeacula", Arg.Any<DateTimeOffset>(), "chat cleared", Arg.Any<Guid>(), Arg.Any<CancellationToken>());
    await f.Mediator.Received(1).Publish(
      Arg.Is<ChatModeratedBroadcastNotification>(n => n.ModerationEvent.DeletedReason == "chat cleared"),
      Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task PersistsBeforeBroadcasting()
  {
    var f = Build();
    var moderationEvent = new ChatModerationEvent(
      "chat.clear", "codeacula", MessageId: null, Username: null, DateTimeOffset.UtcNow, "unused");

    await f.Handler.Handle(new ChatModeratedNotification(moderationEvent), CancellationToken.None);

    Received.InOrder(() =>
    {
      _ = f.ChatStore.MarkChannelMessagesDeletedAsync(
        Arg.Any<string>(), Arg.Any<DateTimeOffset>(), Arg.Any<string>(), Arg.Any<Guid>(), Arg.Any<CancellationToken>());
      _ = f.Mediator.Publish(Arg.Any<ChatModeratedBroadcastNotification>(), Arg.Any<CancellationToken>());
    });
  }

  [Fact]
  public async Task BroadcastCarriesThePersistedEventsOccurredAtRatherThanTheRawIngestedTimestamp()
  {
    var chatStore = Substitute.For<IChatStore>();
    var mediator = Substitute.For<IMediator>();
    var persistedOccurredAt = DateTimeOffset.UtcNow.AddSeconds(-30);
    var persistedEventId = Guid.NewGuid();
    _ = chatStore.AppendChatEventAsync(
        Arg.Any<string>(), Arg.Any<string>(), Arg.Any<string>(), Arg.Any<string?>(), Arg.Any<string?>(),
        Arg.Any<DateTimeOffset>(), Arg.Any<CancellationToken>())
      .Returns(new ChatEventAppendResult(persistedEventId, persistedOccurredAt));
    var handler = new PersistChatModerationHandler(chatStore, mediator);
    var rawDeletedAt = DateTimeOffset.UtcNow; // deliberately different from persistedOccurredAt
    var moderationEvent = new ChatModerationEvent(
      "chat.clear", "codeacula", MessageId: null, Username: null, rawDeletedAt, "unused");

    await handler.Handle(new ChatModeratedNotification(moderationEvent), CancellationToken.None);

    await chatStore.Received(1).MarkChannelMessagesDeletedAsync(
      "codeacula", persistedOccurredAt, Arg.Any<string>(), persistedEventId, Arg.Any<CancellationToken>());
    await mediator.Received(1).Publish(
      Arg.Is<ChatModeratedBroadcastNotification>(n => n.ModerationEvent.DeletedAt == persistedOccurredAt),
      Arg.Any<CancellationToken>());
  }
}
