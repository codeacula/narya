using NSubstitute;

using Narya.Application.Automod;
using Narya.Core.Automod;

namespace Narya.Application.Tests.Automod;

public sealed class GetAutomodQueueQueryTests
{
  [Fact]
  public async Task ReturnsTheStoresQueue()
  {
    var store = Substitute.For<IAutomodStore>();
    var hold = new AutomodHold(
      Id: "held-1", Channel: "codeacula", Username: "viewer", DisplayName: "Viewer", Message: "hi",
      Category: null, Level: null, HeldAt: DateTimeOffset.UtcNow);
    var queue = new AutomodQueue([hold], []);
    _ = store.GetQueueAsync(Arg.Any<CancellationToken>()).Returns(queue);
    var handler = new GetAutomodQueueQueryHandler(store);

    var result = await handler.Handle(new GetAutomodQueueQuery(), CancellationToken.None);

    Assert.Same(queue, result);
  }
}
