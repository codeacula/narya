using NSubstitute;

using Narya.Application.Chat;
using Narya.Core.Chat;

namespace Narya.Application.Tests.Chat;

public sealed class GetRecentChatMessagesQueryHandlerTests
{
  [Fact]
  public async Task ForwardsToTheStoreWithTheLegacyLimitOfForty()
  {
    var store = Substitute.For<IChatStore>();
    IReadOnlyList<ChatMessage> expected = [];
    _ = store.GetRecentMessagesAsync(40, Arg.Any<CancellationToken>()).Returns(expected);
    var handler = new GetRecentChatMessagesQueryHandler(store);

    var result = await handler.Handle(new GetRecentChatMessagesQuery(), CancellationToken.None);

    Assert.Same(expected, result);
    _ = await store.Received(1).GetRecentMessagesAsync(40, Arg.Any<CancellationToken>());
  }
}

public sealed class GetRecentChatEventsQueryHandlerTests
{
  [Fact]
  public async Task ForwardsToTheStoreWithTheLegacyLimitOfOneHundred()
  {
    var store = Substitute.For<IChatStore>();
    IReadOnlyList<ChatEvent> expected = [];
    _ = store.GetRecentEventsAsync(100, Arg.Any<CancellationToken>()).Returns(expected);
    var handler = new GetRecentChatEventsQueryHandler(store);

    var result = await handler.Handle(new GetRecentChatEventsQuery(), CancellationToken.None);

    Assert.Same(expected, result);
    _ = await store.Received(1).GetRecentEventsAsync(100, Arg.Any<CancellationToken>());
  }
}
