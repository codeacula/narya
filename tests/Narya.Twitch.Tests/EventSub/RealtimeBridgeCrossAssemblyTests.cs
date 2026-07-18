using MediatR;

using Microsoft.Extensions.DependencyInjection;

using NSubstitute;

using Narya.Application;
using Narya.Core.Realtime;
using Narya.Twitch.Chat;
using Narya.Twitch.EventSub.Notifications;

namespace Narya.Twitch.Tests.EventSub;

/// <summary>
/// The DI-approach question the Task 6 brief flagged explicitly: does a notification TYPE
/// defined in <c>Narya.Twitch</c> (not the assembly MediatR's
/// <c>RegisterServicesFromAssemblyContaining&lt;NaryaApplication&gt;</c> scans) still reach
/// <c>Narya.Application.Realtime.RealtimeBridgeHandler&lt;T&gt;</c>? Yes — proven empirically
/// here rather than assumed. <c>RealtimeBridgeHandler&lt;T&gt;</c> is registered as an OPEN
/// generic (<c>typeof(INotificationHandler&lt;&gt;)</c> → <c>typeof(RealtimeBridgeHandler&lt;&gt;)</c>)
/// by that assembly scan; resolving a CLOSED <c>INotificationHandler&lt;ChatMessageReceivedNotification&gt;</c>
/// at publish time only requires the .NET DI container to construct
/// <c>RealtimeBridgeHandler&lt;ChatMessageReceivedNotification&gt;</c> via reflection — which
/// needs <c>ChatMessageReceivedNotification</c> to satisfy the handler's type constraint
/// (<see cref="IRealtimeNotification"/> + <see cref="INotification"/>), NOT to live in an
/// assembly MediatR scanned. No second <c>AddMediatR</c> call registering
/// <c>Narya.Twitch</c>'s assembly, and no direct <see cref="IRealtimePublisher"/> call from the
/// dispatch handlers, was needed — <c>AddNaryaApplication()</c> alone is sufficient, exactly as
/// it already is for every notification Narya.Application itself defines.
///
/// This test project referencing <c>Narya.Application</c> is test-only (see
/// <c>Narya.Twitch.Tests.csproj</c>'s comment) — production <c>Narya.Twitch</c> has no
/// dependency on <c>Narya.Application</c>; only <c>Narya.Api</c> composes both.
/// </summary>
public sealed class RealtimeBridgeCrossAssemblyTests
{
  [Fact]
  public async Task ANaryaTwitchNotificationReachesTheRealtimeBridgeAndPublishesUnderItsEventName()
  {
    var publisher = Substitute.For<IRealtimePublisher>();
    var services = new ServiceCollection();
    _ = services.AddLogging();
    _ = services.AddNaryaApplication();
    _ = services.AddSingleton(publisher);

    await using var provider = services.BuildServiceProvider();
    var mediator = provider.GetRequiredService<IMediator>();

    var message = new ChatMessage(
      Id: "msg-1", Channel: "codeacula", Username: "viewer", DisplayName: "Viewer",
      Color: null, Message: "hi", ReceivedAt: DateTimeOffset.UtcNow, Badges: null, ChatterUserId: "viewer-id-1");

    await mediator.Publish(new ChatMessageReceivedNotification(message));

    await publisher.Received(1).PublishAsync("chat:message", message, Arg.Any<CancellationToken>());
  }

  [Fact]
  public void ResolvesExactlyOneHandlerForANaryaTwitchDefinedRealtimeNotification()
  {
    var services = new ServiceCollection();
    _ = services.AddLogging();
    _ = services.AddNaryaApplication();
    _ = services.AddSingleton(Substitute.For<IRealtimePublisher>());

    using var provider = services.BuildServiceProvider();
    var handlers = provider.GetServices<INotificationHandler<ChatMessageReceivedNotification>>();

    _ = Assert.Single(handlers);
  }
}
