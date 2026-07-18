namespace Narya.Core.Twitch;

/// <summary>
/// The single "the Twitch identity this process is talking as, or about, just changed" signal.
/// Narya's Twitch components cache identity in memory for the process lifetime — the resolved
/// broadcaster id, the app access token, and the bot account's login (the bot-loop guard's
/// comparand). Nothing about those caches expires on its own, so an operator who switches the
/// broadcaster channel or reconnects the bot account keeps hitting the OLD identity until the
/// process restarts: every Helix call targets the previous broadcaster, EventSub stays
/// subscribed to the previous channel, and — the security-relevant one — the bot-loop guard
/// compares against the previous bot login, so the bot can answer its own messages.
///
/// This is the port for the invalidation legacy already had and the rewrite dropped:
/// <c>reconcileServices</c> in <c>legacy/src/server/index.ts</c> cleared the cached channel
/// state, reset the app token, and reconnected EventSub whenever <c>twitchChannel</c> or the
/// Twitch credentials changed.
///
/// It lives in <c>Narya.Core</c> rather than <c>Narya.Twitch</c> for the usual layering reason
/// (see <see cref="Realtime.IRealtimePublisher"/> and
/// <see cref="Dashboard.IDashboardTwitchStatusProvider"/>): the config-update command handler
/// that must trigger it lives in <c>Narya.Application</c>, which must never reference
/// <c>Narya.Twitch</c>. <see cref="NullTwitchIdentityInvalidator"/> is the
/// <c>TryAddSingleton</c> default so a host that composes Application without Twitch
/// (<c>Narya.Agent</c>, a <c>WebApplicationFactory</c> test under
/// <c>Narya:SkipInfrastructure</c>) still builds.
/// </summary>
public interface ITwitchIdentityInvalidator
{
  /// <summary>
  /// Drops every cached Twitch identity and, where a live EventSub socket exists, causes it to
  /// re-subscribe against the current broadcaster. Deliberately one coarse call rather than a
  /// per-cache API: callers must not have to know which caches exist, and a save that changes
  /// several Twitch fields at once must produce exactly ONE invalidation (and therefore one
  /// reconnect), not one per field.
  ///
  /// Best-effort, like realtime publish: it runs after the write it reacts to has already
  /// committed, so an implementation reports failure by logging, never by throwing.
  /// </summary>
  Task InvalidateAsync(CancellationToken cancellationToken);
}
