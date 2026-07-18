using MediatR;

using NSubstitute;

using Narya.Application.Events;
using Narya.Core.Events;

namespace Narya.Application.Tests.Events;

public sealed class UpdateStreamEventHandlerTests
{
  [Fact]
  public async Task UpdatesTheStoredRowThenBroadcasts()
  {
    var eventStore = Substitute.For<IStreamEventStore>();
    var mediator = Substitute.For<IMediator>();
    var handler = new UpdateStreamEventHandler(eventStore, mediator);
    var update = new StreamEventUpdate("event-1", "resub · Tier 1 · 3 months", "warning");

    await handler.Handle(new StreamEventUpdateIngestedNotification(update), CancellationToken.None);

    await eventStore.Received(1).UpdateDetailToneAsync(
      "event-1", "resub · Tier 1 · 3 months", "warning", Arg.Any<CancellationToken>());
    await mediator.Received(1).Publish(
      Arg.Is<StreamEventUpdateBroadcastNotification>(n => n.Update == update), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task PersistsBeforeBroadcastingSoAFailedUpdateNeverBroadcasts()
  {
    var eventStore = Substitute.For<IStreamEventStore>();
    var mediator = Substitute.For<IMediator>();
    var handler = new UpdateStreamEventHandler(eventStore, mediator);
    _ = eventStore.UpdateDetailToneAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<string>(), Arg.Any<CancellationToken>())
      .Returns(Task.FromException(new InvalidOperationException("store unavailable")));

    var update = new StreamEventUpdate("event-1", "detail", "tone");

    _ = await Assert.ThrowsAsync<InvalidOperationException>(
      () => handler.Handle(new StreamEventUpdateIngestedNotification(update), CancellationToken.None));

    await mediator.DidNotReceive().Publish(Arg.Any<StreamEventUpdateBroadcastNotification>(), Arg.Any<CancellationToken>());
  }
}
