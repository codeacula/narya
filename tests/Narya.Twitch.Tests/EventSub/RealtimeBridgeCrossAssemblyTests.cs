using MediatR;

using Microsoft.Extensions.DependencyInjection;

using NSubstitute;

using Narya.Application;
using Narya.Core.Realtime;
using Narya.Twitch.EventSub.Notifications;

namespace Narya.Twitch.Tests.EventSub;

/// <summary>
/// The DI-approach question the Task 6 brief flagged explicitly: does a notification TYPE
/// defined in <c>Narya.Twitch</c> (not the assembly MediatR's
/// <c>RegisterServicesFromAssemblyContaining&lt;NaryaApplication&gt;</c> scans) still reach
/// <c>Narya.Application.Realtime.RealtimeBridgeHandler&lt;T&gt;</c>? Yes — proven empirically
/// here rather than assumed. <c>RealtimeBridgeHandler&lt;T&gt;</c> is registered as an OPEN
/// generic (<c>typeof(INotificationHandler&lt;&gt;)</c> → <c>typeof(RealtimeBridgeHandler&lt;&gt;)</c>)
/// by that assembly scan; resolving a CLOSED <c>INotificationHandler&lt;WhisperReceivedNotification&gt;</c>
/// at publish time only requires the .NET DI container to construct
/// <c>RealtimeBridgeHandler&lt;WhisperReceivedNotification&gt;</c> via reflection — which needs
/// <c>WhisperReceivedNotification</c> to satisfy the handler's type constraint
/// (<see cref="IRealtimeNotification"/> + <see cref="INotification"/>), NOT to live in an
/// assembly MediatR scanned. No second <c>AddMediatR</c> call registering
/// <c>Narya.Twitch</c>'s assembly, and no direct <see cref="IRealtimePublisher"/> call from the
/// dispatch handlers, was needed — <c>AddNaryaApplication()</c> alone is sufficient, exactly as
/// it already is for every notification Narya.Application itself defines.
///
/// Originally exercised this with <c>ChatMessageReceivedNotification</c> (Phase 2); repointed at
/// <c>StreamEventOccurredNotification</c> in Phase 3 Task 1 once chat's ingested→broadcast split
/// moved and renamed that type to <c>Narya.Core.Chat.ChatMessageIngestedNotification</c> — a
/// plain <see cref="INotification"/>, no longer an <see cref="IRealtimeNotification"/>, so it
/// could no longer stand in for "a Narya.Twitch-defined realtime notification" here. Repointed
/// again, at <see cref="WhisperReceivedNotification"/>, in Task 4 once stream events went through
/// the identical split (<c>StreamEventOccurredNotification</c> → <c>Narya.Core.Events.StreamEventIngestedNotification</c>,
/// also no longer an <see cref="IRealtimeNotification"/>) — <see cref="WhisperReceivedNotification"/>
/// is deliberately the one Narya.Twitch-defined notification the plan keeps as a direct broadcast
/// (see that type's doc comment: legacy never persists whispers, so there is nothing to enrich
/// before broadcasting), so it remains a stable target for this test's premise even as every
/// other EventSub-sourced realtime notification migrates off Narya.Twitch.
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

    var whisper = new WhisperMessage(
      Id: "whisper-1", FromLogin: "viewer", FromDisplayName: "Viewer", Text: "hey", ReceivedAt: DateTimeOffset.UtcNow);

    await mediator.Publish(new WhisperReceivedNotification(whisper));

    await publisher.Received(1).PublishAsync("whisper:message", whisper, Arg.Any<CancellationToken>());
  }

  [Fact]
  public void ResolvesExactlyOneHandlerForANaryaTwitchDefinedRealtimeNotification()
  {
    var services = new ServiceCollection();
    _ = services.AddLogging();
    _ = services.AddNaryaApplication();
    _ = services.AddSingleton(Substitute.For<IRealtimePublisher>());

    using var provider = services.BuildServiceProvider();
    var handlers = provider.GetServices<INotificationHandler<WhisperReceivedNotification>>();

    _ = Assert.Single(handlers);
  }
}
