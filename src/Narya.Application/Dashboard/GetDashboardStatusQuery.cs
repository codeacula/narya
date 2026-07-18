using MediatR;

using Narya.Core.AppConfig;
using Narya.Core.Chat;
using Narya.Core.Dashboard;
using Narya.Core.Sessions;

namespace Narya.Application.Dashboard;

/// <summary>
/// A port of legacy's <c>GET /api/dashboard/status</c>/<c>getDashboardStatusSnapshot</c>
/// (<c>legacy/src/server/dashboard/status.ts</c>) — also what
/// <c>Narya.Api.Dashboard.DashboardHeartbeatService</c> sends every tick, so the REST and
/// <c>dashboard:status</c> broadcast shapes never drift apart.
/// </summary>
public sealed record GetDashboardStatusQuery : IRequest<DashboardStatus>;

/// <summary>
/// Aggregates <see cref="DashboardStatus"/> from four sources: the chat/session/chatter counts
/// (<see cref="IChatStore"/>/<see cref="IStreamSessionStore"/>), the configured channel
/// (<see cref="IAppConfigStore"/>), and Twitch auth/EventSub status
/// (<see cref="IDashboardTwitchStatusProvider"/> — see that interface's doc comment for why this
/// indirection exists rather than depending on Narya.Twitch directly). OBS/ad-schedule/stream-live
/// fields are left at <see cref="DashboardStatus"/>'s own defaults — see that record's doc
/// comment for the live/deferred split.
/// </summary>
public sealed class GetDashboardStatusQueryHandler(
  IChatStore chatStore,
  IStreamSessionStore sessionStore,
  IAppConfigStore appConfigStore,
  IDashboardTwitchStatusProvider twitchStatusProvider,
  TimeProvider timeProvider) : IRequestHandler<GetDashboardStatusQuery, DashboardStatus>
{
  /// <summary>Matches legacy's 15-minute window in <c>getActiveChatterCount</c>.</summary>
  private static readonly TimeSpan ActiveChatterWindow = TimeSpan.FromMinutes(15);

  public async Task<DashboardStatus> Handle(GetDashboardStatusQuery request, CancellationToken cancellationToken)
  {
    var since = timeProvider.GetUtcNow() - ActiveChatterWindow;

    var activeChatters = await chatStore.GetActiveChatterCountAsync(since, cancellationToken).ConfigureAwait(false);
    var knownChatters = await chatStore.GetKnownChatterCountAsync(cancellationToken).ConfigureAwait(false);
    var sessionChatters = await sessionStore.GetSessionChatterCountAsync(cancellationToken).ConfigureAwait(false);
    var activeSession = await sessionStore.GetActiveSessionAsync(cancellationToken).ConfigureAwait(false);
    var twitchStatus = await twitchStatusProvider.GetAsync(cancellationToken).ConfigureAwait(false);
    var channel = await ResolveChannelAsync(cancellationToken).ConfigureAwait(false);

    return new DashboardStatus
    {
      Channel = channel,
      // Chat now arrives over the same EventSub socket as everything else (twitchlib-spec.md) —
      // see DashboardStatus.ChatConnection's doc comment for why this mirrors EventSubConnected
      // rather than a separate IRC ready-state the way legacy's tmi.js client reported.
      ChatConnection = twitchStatus.EventSubConnected ? "OPEN" : "CLOSED",
      EventSubConnected = twitchStatus.EventSubConnected,
      EventSubError = twitchStatus.EventSubError,
      EventSubFailedSubscriptions = twitchStatus.EventSubFailedSubscriptions,
      TwitchAuthenticated = twitchStatus.TwitchAuthenticated,
      TwitchAuthSource = twitchStatus.TwitchAuthSource,
      TwitchTokenExpiresAt = twitchStatus.TwitchTokenExpiresAt,
      TwitchMissingScopes = twitchStatus.TwitchMissingScopes,
      TwitchBotAuthenticated = twitchStatus.TwitchBotAuthenticated,
      TwitchBotAuthSource = twitchStatus.TwitchBotAuthSource,
      TwitchBotTokenExpiresAt = twitchStatus.TwitchBotTokenExpiresAt,
      TwitchBotMissingScopes = twitchStatus.TwitchBotMissingScopes,
      ActiveChatters = activeChatters,
      SessionChatters = sessionChatters,
      KnownChatters = knownChatters,
      StreamSessionId = activeSession?.Id,
      StreamSessionStartedAt = activeSession?.StartedAt,
      // Everything below (ObsConnected, StreamActive, ad-schedule, frame stats, ...) is left at
      // DashboardStatus's own defaults — Phase 8/OBS territory, not yet wired.
    };
  }

  /// <summary>Mirrors the empty-channel fallback already used by <c>RecordAutomodHoldHandler.ResolveChannelAsync</c> — a store failure degrades to "" rather than failing the whole snapshot.</summary>
  private async Task<string> ResolveChannelAsync(CancellationToken cancellationToken)
  {
    var configResult = await appConfigStore.GetAsync(cancellationToken).ConfigureAwait(false);
    return configResult.IsFailed ? string.Empty : configResult.Value.TwitchChannel;
  }
}
