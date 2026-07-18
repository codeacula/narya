using NSubstitute;

using Narya.Application.Dashboard;
using Narya.Core.Events;
using Narya.Core.Sessions;

namespace Narya.Application.Tests.Dashboard;

public sealed class GetSessionShoutoutsQueryTests
{
  private static readonly string[] ExpectedThankWorthyKinds = ["follow", "sub", "gift", "cheer", "raid", "redeem"];

  private static StreamEvent BuildEvent(
    string id, string kind, string actor, string detail, DateTimeOffset receivedAt, string? actorLogin = null) =>
    new(Id: id, Kind: kind, Actor: actor, Detail: detail, Tone: "silver", ReceivedAt: receivedAt, ActorLogin: actorLogin);

  [Fact]
  public async Task ReturnsEmptyWhenThereIsNoActiveSession()
  {
    var eventStore = Substitute.For<IStreamEventStore>();
    var sessionStore = Substitute.For<IStreamSessionStore>();
    _ = sessionStore.GetCurrentSessionIdAsync(Arg.Any<CancellationToken>()).Returns((string?)null);
    var handler = new GetSessionShoutoutsQueryHandler(eventStore, sessionStore);

    var result = await handler.Handle(new GetSessionShoutoutsQuery(), CancellationToken.None);

    Assert.Empty(result);
    _ = await eventStore.DidNotReceive().GetSessionShoutoutEventsAsync(
      Arg.Any<string>(), Arg.Any<IReadOnlyList<string>>(), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task RequestsTheThankWorthyKindsExcludingAdBreak()
  {
    var eventStore = Substitute.For<IStreamEventStore>();
    var sessionStore = Substitute.For<IStreamSessionStore>();
    _ = sessionStore.GetCurrentSessionIdAsync(Arg.Any<CancellationToken>()).Returns("session-1");
    _ = eventStore.GetSessionShoutoutEventsAsync(
      Arg.Any<string>(), Arg.Any<IReadOnlyList<string>>(), Arg.Any<CancellationToken>()).Returns([]);
    var handler = new GetSessionShoutoutsQueryHandler(eventStore, sessionStore);

    _ = await handler.Handle(new GetSessionShoutoutsQuery(), CancellationToken.None);

    _ = await eventStore.Received(1).GetSessionShoutoutEventsAsync(
      "session-1",
      Arg.Is<IReadOnlyList<string>>(kinds => !kinds.Contains("ad_break")
        && kinds.SequenceEqual(ExpectedThankWorthyKinds)),
      Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task AFollowThenAResubForTheSameActorMergeIntoOneEntry()
  {
    var eventStore = Substitute.For<IStreamEventStore>();
    var sessionStore = Substitute.For<IStreamSessionStore>();
    _ = sessionStore.GetCurrentSessionIdAsync(Arg.Any<CancellationToken>()).Returns("session-1");
    var start = DateTimeOffset.UtcNow;
    IReadOnlyList<StreamEvent> events =
    [
      BuildEvent("follow-1", "follow", "Viewer", "followed", start, actorLogin: "viewer"),
      BuildEvent("sub-1", "sub", "Viewer", "resub · Tier 1 · 3 months", start.AddMinutes(10), actorLogin: "viewer"),
    ];
    _ = eventStore.GetSessionShoutoutEventsAsync(
      "session-1", Arg.Any<IReadOnlyList<string>>(), Arg.Any<CancellationToken>()).Returns(events);
    var handler = new GetSessionShoutoutsQueryHandler(eventStore, sessionStore);

    var result = await handler.Handle(new GetSessionShoutoutsQuery(), CancellationToken.None);

    var shoutout = Assert.Single(result);
    Assert.Equal("Viewer", shoutout.Actor);
    Assert.Equal("viewer", shoutout.Login);
    Assert.Equal(["follow", "sub"], shoutout.Kinds);
    Assert.Equal("resub · Tier 1 · 3 months", shoutout.Detail); // most-recent wins
    Assert.Equal(start, shoutout.FirstAt);
    Assert.Equal(start.AddMinutes(10), shoutout.LastAt);
  }

  [Fact]
  public async Task ASecondActorProducesASecondEntry()
  {
    var eventStore = Substitute.For<IStreamEventStore>();
    var sessionStore = Substitute.For<IStreamSessionStore>();
    _ = sessionStore.GetCurrentSessionIdAsync(Arg.Any<CancellationToken>()).Returns("session-1");
    var start = DateTimeOffset.UtcNow;
    IReadOnlyList<StreamEvent> events =
    [
      BuildEvent("follow-1", "follow", "Alice", "followed", start, actorLogin: "alice"),
      BuildEvent("follow-2", "follow", "Bob", "followed", start.AddSeconds(1), actorLogin: "bob"),
    ];
    _ = eventStore.GetSessionShoutoutEventsAsync(
      "session-1", Arg.Any<IReadOnlyList<string>>(), Arg.Any<CancellationToken>()).Returns(events);
    var handler = new GetSessionShoutoutsQueryHandler(eventStore, sessionStore);

    var result = await handler.Handle(new GetSessionShoutoutsQuery(), CancellationToken.None);

    Assert.Equal(2, result.Count);
    Assert.Contains(result, s => s.Login == "alice");
    Assert.Contains(result, s => s.Login == "bob");
  }

  [Fact]
  public async Task ResultsAreSortedByLastAtDescending()
  {
    var eventStore = Substitute.For<IStreamEventStore>();
    var sessionStore = Substitute.For<IStreamSessionStore>();
    _ = sessionStore.GetCurrentSessionIdAsync(Arg.Any<CancellationToken>()).Returns("session-1");
    var start = DateTimeOffset.UtcNow;
    IReadOnlyList<StreamEvent> events =
    [
      BuildEvent("follow-1", "follow", "Alice", "followed", start, actorLogin: "alice"), // earliest
      BuildEvent("follow-2", "follow", "Bob", "followed", start.AddMinutes(5), actorLogin: "bob"), // latest
    ];
    _ = eventStore.GetSessionShoutoutEventsAsync(
      "session-1", Arg.Any<IReadOnlyList<string>>(), Arg.Any<CancellationToken>()).Returns(events);
    var handler = new GetSessionShoutoutsQueryHandler(eventStore, sessionStore);

    var result = await handler.Handle(new GetSessionShoutoutsQuery(), CancellationToken.None);

    Assert.Equal(["bob", "alice"], result.Select(s => s.Login));
  }

  /// <summary>
  /// A row recorded before logins were stored (<see cref="StreamEvent.ActorLogin"/> null) groups
  /// by the lowercased <see cref="StreamEvent.Actor"/>; a later row for the same person that DOES
  /// carry a login lands under the same key (the login equals the lowercased actor by
  /// construction here) and backfills <see cref="Narya.Core.Dashboard.SessionShoutout.Login"/>.
  /// </summary>
  [Fact]
  public async Task LoginIsBackfilledFromALaterRowWhenTheFirstRowLacksIt()
  {
    var eventStore = Substitute.For<IStreamEventStore>();
    var sessionStore = Substitute.For<IStreamSessionStore>();
    _ = sessionStore.GetCurrentSessionIdAsync(Arg.Any<CancellationToken>()).Returns("session-1");
    var start = DateTimeOffset.UtcNow;
    IReadOnlyList<StreamEvent> events =
    [
      BuildEvent("follow-1", "follow", "Viewer", "followed", start, actorLogin: null),
      BuildEvent("sub-1", "sub", "Viewer", "resubbed", start.AddMinutes(1), actorLogin: "viewer"),
    ];
    _ = eventStore.GetSessionShoutoutEventsAsync(
      "session-1", Arg.Any<IReadOnlyList<string>>(), Arg.Any<CancellationToken>()).Returns(events);
    var handler = new GetSessionShoutoutsQueryHandler(eventStore, sessionStore);

    var result = await handler.Handle(new GetSessionShoutoutsQuery(), CancellationToken.None);

    var shoutout = Assert.Single(result);
    Assert.Equal("viewer", shoutout.Login);
    Assert.Equal(["follow", "sub"], shoutout.Kinds);
  }
}
