namespace Narya.Core.Dashboard;

/// <summary>
/// The Twitch-auth/EventSub half of <see cref="DashboardStatus"/> — split out into its own
/// port so <c>Narya.Application.Dashboard.GetDashboardStatusQueryHandler</c> can depend on it
/// without Narya.Application taking a reference on Narya.Twitch (the same reference-direction
/// constraint documented on <c>Narya.Core.Events.IStreamEventStore</c>/<c>Narya.Core.Chat.IChatStore</c>:
/// Narya.Application deliberately references only Narya.Core/Narya.Domain).
///
/// Implemented by <c>Narya.Twitch.Dashboard.TwitchDashboardStatusProvider</c>, which composes
/// Phase 2's <c>Narya.Twitch.Oauth.ITwitchTokenStore</c> (the auth fields — the same
/// broadcaster/bot token lookup <c>Narya.Api.Controllers.TwitchAuthController.BuildStatusAsync</c>
/// performs) and <c>Narya.Twitch.EventSub.ITwitchEventSource.Status</c> (the EventSub fields).
/// Registered <c>AddSingleton&lt;IDashboardTwitchStatusProvider, TwitchDashboardStatusProvider&gt;</c>
/// in <c>Narya.Twitch.ServiceCollectionExtensions.AddNaryaTwitch</c>.
/// </summary>
public interface IDashboardTwitchStatusProvider
{
  Task<DashboardTwitchStatus> GetAsync(CancellationToken cancellationToken);
}

/// <summary>
/// The subset of <see cref="DashboardStatus"/> this provider is responsible for — see
/// <see cref="IDashboardTwitchStatusProvider"/>'s doc comment. Field names and semantics mirror
/// <see cref="DashboardStatus"/>'s own <c>Twitch*</c>/<c>TwitchBot*</c>/<c>EventSub*</c> fields
/// exactly, so <c>GetDashboardStatusQueryHandler</c> can copy them across without translation.
/// </summary>
public sealed record DashboardTwitchStatus
{
  public required bool TwitchAuthenticated { get; init; }

  public string? TwitchAuthSource { get; init; }

  public DateTimeOffset? TwitchTokenExpiresAt { get; init; }

  public required IReadOnlyList<string> TwitchMissingScopes { get; init; }

  public required bool TwitchBotAuthenticated { get; init; }

  public string? TwitchBotAuthSource { get; init; }

  public DateTimeOffset? TwitchBotTokenExpiresAt { get; init; }

  public required IReadOnlyList<string> TwitchBotMissingScopes { get; init; }

  public required bool EventSubConnected { get; init; }

  public string? EventSubError { get; init; }

  /// <summary>Always empty — see <see cref="DashboardStatus.EventSubFailedSubscriptions"/>'s doc comment.</summary>
  public required IReadOnlyList<string> EventSubFailedSubscriptions { get; init; }
}
