using Narya.Core.Dashboard;
using Narya.Twitch.EventSub;
using Narya.Twitch.Tokens;

namespace Narya.Twitch.Dashboard;

/// <summary>
/// <see cref="IDashboardTwitchStatusProvider"/> backed by the same two Phase 2 sources
/// <c>Narya.Api.Controllers.TwitchAuthController.BuildStatusAsync</c> reads: the stored
/// broadcaster/bot tokens (<see cref="ITwitchTokenStore"/>) for the auth fields, and
/// <see cref="ITwitchEventSource.Status"/> for the EventSub fields. Registered
/// <c>AddSingleton&lt;IDashboardTwitchStatusProvider, TwitchDashboardStatusProvider&gt;</c> in
/// <c>Narya.Twitch.ServiceCollectionExtensions.AddNaryaTwitch</c>.
///
/// A store failure (<see cref="ITwitchTokenStore.GetAsync"/> returning a failed
/// <see cref="FluentResults.Result{T}"/>) degrades to "not authenticated" for that provider
/// rather than throwing — the dashboard heartbeat must keep reporting on a bad Marten read, not
/// go dark, mirroring the same degrade-not-throw choice
/// <c>Narya.Application.Automod.RecordAutomodHoldHandler.ResolveChannelAsync</c> makes for a
/// failed config lookup.
/// </summary>
public sealed class TwitchDashboardStatusProvider(ITwitchTokenStore tokenStore, ITwitchEventSource eventSource)
  : IDashboardTwitchStatusProvider
{
  public async Task<DashboardTwitchStatus> GetAsync(CancellationToken cancellationToken)
  {
    var broadcasterResult = await tokenStore.GetAsync(TwitchProvider.Broadcaster, cancellationToken).ConfigureAwait(false);
    var botResult = await tokenStore.GetAsync(TwitchProvider.Bot, cancellationToken).ConfigureAwait(false);

    var broadcaster = broadcasterResult.IsSuccess ? broadcasterResult.Value : null;
    var bot = botResult.IsSuccess ? botResult.Value : null;
    var eventSubStatus = eventSource.Status;

    return new DashboardTwitchStatus
    {
      TwitchAuthenticated = broadcaster is not null,
      TwitchAuthSource = broadcaster is not null ? "oauth" : null,
      TwitchTokenExpiresAt = broadcaster?.ExpiresAt,
      TwitchMissingScopes = broadcaster is null ? [] : MissingScopes(broadcaster.Scopes, Scopes.Broadcaster),
      TwitchBotAuthenticated = bot is not null,
      TwitchBotAuthSource = bot is not null ? "oauth" : null,
      TwitchBotTokenExpiresAt = bot?.ExpiresAt,
      TwitchBotMissingScopes = bot is null ? [] : MissingScopes(bot.Scopes, Scopes.Bot),
      EventSubConnected = eventSubStatus.Connected,
      EventSubError = eventSubStatus.LastError,
      // Phase 2's EventSubStatus tracks only a single LastError string, not a per-subscription
      // failure list — see DashboardStatus.EventSubFailedSubscriptions's doc comment.
      EventSubFailedSubscriptions = [],
    };
  }

  /// <summary>The set difference <paramref name="required"/> minus <paramref name="tokenScopes"/> — mirrors <c>TwitchAuthController.MissingScopes</c>.</summary>
  private static IReadOnlyList<string> MissingScopes(IReadOnlyList<string> tokenScopes, IReadOnlyList<string> required) =>
    [.. required.Except(tokenScopes)];
}
