using MediatR;

using NSubstitute;

using Narya.Application.Events;
using Narya.Core.Events;
using Narya.Core.Sessions;

namespace Narya.Application.Tests.Events;

public sealed class PersistStreamEventHandlerTests
{
  private sealed record Fixture(IStreamEventStore EventStore, IStreamSessionStore SessionStore, IMediator Mediator, PersistStreamEventHandler Handler);

  private static Fixture Build(string? currentSessionId = null)
  {
    var eventStore = Substitute.For<IStreamEventStore>();
    var sessionStore = Substitute.For<IStreamSessionStore>();
    var mediator = Substitute.For<IMediator>();

    _ = eventStore.InsertAsync(Arg.Any<StreamEvent>(), Arg.Any<CancellationToken>()).Returns(true);
    _ = sessionStore.GetCurrentSessionIdAsync(Arg.Any<CancellationToken>()).Returns(currentSessionId);

    var handler = new PersistStreamEventHandler(eventStore, sessionStore, mediator);
    return new Fixture(eventStore, sessionStore, mediator, handler);
  }

  private static StreamEvent BuildEvent(string? actorLogin = null) => new(
    Id: "event-1", Kind: "follow", Actor: "Viewer", Detail: "followed", Tone: "silver",
    ReceivedAt: DateTimeOffset.UtcNow, ActorLogin: actorLogin);

  [Fact]
  public async Task StampsTheCurrentSessionIdOntoThePersistedAndBroadcastEvent()
  {
    var f = Build(currentSessionId: "session-1");

    await f.Handler.Handle(new StreamEventIngestedNotification(BuildEvent()), CancellationToken.None);

    _ = await f.EventStore.Received(1).InsertAsync(
      Arg.Is<StreamEvent>(e => e.SessionId == "session-1"), Arg.Any<CancellationToken>());
    await f.Mediator.Received(1).Publish(
      Arg.Is<StreamEventBroadcastNotification>(n => n.Event.SessionId == "session-1"), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task LowercasesTheActorLoginOnPersistAndBroadcast()
  {
    var f = Build();

    await f.Handler.Handle(new StreamEventIngestedNotification(BuildEvent(actorLogin: "ViewerLogin")), CancellationToken.None);

    _ = await f.EventStore.Received(1).InsertAsync(
      Arg.Is<StreamEvent>(e => e.ActorLogin == "viewerlogin"), Arg.Any<CancellationToken>());
    await f.Mediator.Received(1).Publish(
      Arg.Is<StreamEventBroadcastNotification>(n => n.Event.ActorLogin == "viewerlogin"), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task BroadcastsWithTheLiteralJustNowAgo()
  {
    var f = Build();

    await f.Handler.Handle(new StreamEventIngestedNotification(BuildEvent()), CancellationToken.None);

    await f.Mediator.Received(1).Publish(
      Arg.Is<StreamEventBroadcastNotification>(n => n.Event.Ago == "just now"), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task WithNoActiveSessionSessionIdIsNullButStillPersistedAndBroadcast()
  {
    var f = Build(currentSessionId: null);

    await f.Handler.Handle(new StreamEventIngestedNotification(BuildEvent()), CancellationToken.None);

    _ = await f.EventStore.Received(1).InsertAsync(
      Arg.Is<StreamEvent>(e => e.SessionId == null), Arg.Any<CancellationToken>());
    await f.Mediator.Received(1).Publish(
      Arg.Is<StreamEventBroadcastNotification>(n => n.Event.SessionId == null), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task BroadcastsEvenWhenInsertReportsARedelivery()
  {
    var f = Build();
    _ = f.EventStore.InsertAsync(Arg.Any<StreamEvent>(), Arg.Any<CancellationToken>()).Returns(false);

    await f.Handler.Handle(new StreamEventIngestedNotification(BuildEvent()), CancellationToken.None);

    await f.Mediator.Received(1).Publish(Arg.Any<StreamEventBroadcastNotification>(), Arg.Any<CancellationToken>());
  }
}
