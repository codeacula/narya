using MediatR;

using NSubstitute;

using Narya.Application.Automation;
using Narya.Core.Automation;

namespace Narya.Application.Tests.Automation;

/// <summary>
/// <see cref="GetMediaMuteQueryHandler"/>/<see cref="SetMediaMuteCommandHandler"/> tests — all with
/// test doubles, mirrors <c>ActionExecutorTests</c>'s no-real-infrastructure approach.
/// </summary>
public sealed class MediaMuteCommandHandlerTests
{
  [Fact]
  public async Task GetMediaMuteQueryReturnsWhateverTheStoreReports()
  {
    var store = Substitute.For<IMediaMuteStore>();
    _ = store.GetMutedAsync(Arg.Any<CancellationToken>()).Returns(true);
    var handler = new GetMediaMuteQueryHandler(store);

    var result = await handler.Handle(new GetMediaMuteQuery(), CancellationToken.None);

    Assert.True(result.Muted);
  }

  [Fact]
  public async Task SetMediaMuteCommandPersistsThenReturnsTheStoresResult()
  {
    var store = Substitute.For<IMediaMuteStore>();
    var mediator = Substitute.For<IMediator>();
    _ = store.SetMutedAsync(true, Arg.Any<CancellationToken>()).Returns(new MediaMuteState(true));
    var handler = new SetMediaMuteCommandHandler(store, mediator);

    var result = await handler.Handle(new SetMediaMuteCommand(true), CancellationToken.None);

    Assert.True(result.Muted);
    _ = await store.Received(1).SetMutedAsync(true, Arg.Any<CancellationToken>());
  }

  /// <summary>
  /// Persist-before-broadcast: the published notification must carry exactly the state the store
  /// returned (not the raw request), and the store write must be observed (awaited to completion)
  /// before the notification is published — <c>Received.InOrder</c> asserts the two calls happened
  /// in that sequence on the SAME substitute-tracking timeline, which NSubstitute records
  /// synchronously in call order regardless of the surrounding async/await.
  /// </summary>
  [Fact]
  public async Task SetMediaMuteCommandBroadcastsMediaMuteAfterTheStoreWriteCommits()
  {
    var store = Substitute.For<IMediaMuteStore>();
    var mediator = Substitute.For<IMediator>();
    var persistedState = new MediaMuteState(true);
    _ = store.SetMutedAsync(true, Arg.Any<CancellationToken>()).Returns(persistedState);
    var handler = new SetMediaMuteCommandHandler(store, mediator);

    _ = await handler.Handle(new SetMediaMuteCommand(true), CancellationToken.None);

    Received.InOrder(() =>
    {
      _ = store.SetMutedAsync(true, Arg.Any<CancellationToken>());
      _ = mediator.Publish(
        Arg.Is<MediaMuteBroadcastNotification>(n => n.State == persistedState && n.EventName == "media:mute"),
        Arg.Any<CancellationToken>());
    });
  }

  [Fact]
  public async Task SetMediaMuteCommandFalseBroadcastsMediaMuteFalse()
  {
    var store = Substitute.For<IMediaMuteStore>();
    var mediator = Substitute.For<IMediator>();
    _ = store.SetMutedAsync(false, Arg.Any<CancellationToken>()).Returns(new MediaMuteState(false));
    var handler = new SetMediaMuteCommandHandler(store, mediator);

    _ = await handler.Handle(new SetMediaMuteCommand(false), CancellationToken.None);

    await mediator.Received(1).Publish(
      Arg.Is<MediaMuteBroadcastNotification>(n => !n.State.Muted),
      Arg.Any<CancellationToken>());
  }
}
