using NSubstitute;

using Narya.Application.Viewers;
using Narya.Core.Chat;

namespace Narya.Application.Tests.Viewers;

public sealed class GetViewerMessagesQueryTests
{
  [Fact]
  public async Task LowercasesTheLoginAndRequestsTheLegacyEightyRowPage()
  {
    var store = Substitute.For<IChatStore>();
    _ = store.GetMessagesByUsernameAsync("viewer", "msg-5", 80, Arg.Any<CancellationToken>())
      .Returns([]);
    var handler = new GetViewerMessagesQueryHandler(store);

    _ = await handler.Handle(new GetViewerMessagesQuery("VIEWER", "msg-5"), CancellationToken.None);

    _ = await store.Received(1).GetMessagesByUsernameAsync("viewer", "msg-5", 80, Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task ReturnsTheStoresMessages()
  {
    var store = Substitute.For<IChatStore>();
    IReadOnlyList<ChatMessage> messages =
    [
      new ChatMessage(
        Id: "msg-1", Channel: "codeacula", Username: "viewer", DisplayName: "Viewer",
        Color: null, Message: "hi", ReceivedAt: DateTimeOffset.UtcNow, Badges: null, ChatterUserId: "viewer-id-1"),
    ];
    _ = store.GetMessagesByUsernameAsync("viewer", null, 80, Arg.Any<CancellationToken>()).Returns(messages);
    var handler = new GetViewerMessagesQueryHandler(store);

    var result = await handler.Handle(new GetViewerMessagesQuery("viewer", null), CancellationToken.None);

    Assert.Same(messages, result);
  }
}
