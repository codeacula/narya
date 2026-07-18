using FluentResults;

using Narya.Twitch.Tokens;

namespace Narya.Twitch.Helix;

/// <summary>
/// Typed wrapper around Twitch's Helix REST API, covering the "Twitch-core" endpoints Phase 2
/// needs. Implemented over <c>TwitchLib.Api</c> (see <see cref="TwitchLibHelixApi"/> /
/// <see cref="IHelixApi"/>) rather than a hand-rolled <see cref="HttpClient"/> — every method
/// resolves its own token via <see cref="ITwitchCredentials"/> and passes it as TwitchLib's
/// trailing per-call <c>accessToken</c> argument, so no caller ever sees a raw token, and every
/// TwitchLib failure mode (a thrown <c>TwitchLib.Api.Core.Exceptions</c> type, or Twitch's own
/// non-exception "drop" responses) comes back as a secret-free <see cref="Result"/> instead of
/// an exception escaping this client.
///
/// <see cref="GetBroadcasterIdAsync"/> has the exact same signature as
/// <see cref="IBroadcasterIdResolver.GetBroadcasterIdAsync"/> and IS that implementation — see
/// <c>ServiceCollectionExtensions.AddNaryaTwitch</c> for how the resulting DI cycle
/// (<c>TwitchCredentials</c> needs <c>IBroadcasterIdResolver</c>; this client needs
/// <c>ITwitchCredentials</c>) is broken without either singleton needing to know about it.
///
/// DEFERRED to later phases (do not add here): chatters/VIPs/moderators/followers/subscription
/// lookups (Phase 3 viewers) and channel-point reward CRUD (Phase 8) — see the Phase 2 plan's
/// Task 4 scope note.
/// </summary>
public interface IHelixClient
{
  /// <summary>Self-lookup (<c>GET /users</c>, no query) using <paramref name="provider"/>'s own token.</summary>
  Task<Result<HelixUser>> GetAuthenticatedUserAsync(TwitchProvider provider, CancellationToken cancellationToken);

  /// <summary>
  /// Resolves the broadcaster's user id for the configured channel (<c>AppConfig.TwitchChannel</c>).
  /// Cached in memory for the process lifetime — see <see cref="IBroadcasterIdResolver"/>.
  /// </summary>
  Task<Result<string>> GetBroadcasterIdAsync(CancellationToken cancellationToken);

  /// <summary>Resolves an arbitrary Twitch login to a user id. Fails when the login does not resolve (Twitch 404, or an empty result set).</summary>
  Task<Result<string>> ResolveUserIdAsync(string login, CancellationToken cancellationToken);

  Task<Result<HelixChannelInfo>> GetChannelInfoAsync(CancellationToken cancellationToken);

  Task<Result> UpdateChannelInfoAsync(string title, string gameId, IReadOnlyList<string> tags, CancellationToken cancellationToken);

  /// <summary>Cached for <see cref="HelixCaches.StreamStatusTtl"/> (15s) — a call inside the window returns the cached value with no Helix request.</summary>
  Task<Result<HelixStreamStatus>> GetStreamStatusAsync(CancellationToken cancellationToken);

  /// <summary>Cached for <see cref="HelixCaches.AdScheduleTtl"/> (5s) — a call inside the window returns the cached value with no Helix request.</summary>
  Task<Result<HelixAdSchedule>> GetAdScheduleAsync(CancellationToken cancellationToken);

  Task<Result<IReadOnlyList<HelixCategory>>> SearchCategoriesAsync(string query, CancellationToken cancellationToken);

  /// <summary>Null (not a failure) when Twitch no longer knows this game id.</summary>
  Task<Result<HelixCategory?>> GetGameByIdAsync(string id, CancellationToken cancellationToken);

  /// <summary>
  /// Starts (or joins) a commercial break. Concurrent calls made while one is already in
  /// flight share the same underlying <see cref="Task{TResult}"/> and produce exactly one
  /// TwitchLib <c>StartCommercialAsync</c> call — see <c>HelixClientTests</c>'s single-flight test.
  /// </summary>
  Task<Result<HelixCommercialResult>> RunCommercialAsync(int lengthSeconds = 180, CancellationToken cancellationToken = default);

  /// <summary>
  /// Sends a chat message as <paramref name="sender"/>. Fails when Twitch accepted the request
  /// but declined to deliver the message (<c>is_sent: false</c> or a <c>drop_reason</c> present
  /// — e.g. AutoMod held it); this is a non-exception TwitchLib response, not a thrown error.
  /// </summary>
  Task<Result<string>> SendChatMessageAsync(TwitchProvider sender, string message, string? replyParentMessageId = null, CancellationToken cancellationToken = default);

  Task<Result> SendShoutoutAsync(string toBroadcasterId, CancellationToken cancellationToken);

  /// <summary>Message is capped to 500 characters (Twitch's limit), not rejected.</summary>
  Task<Result> SendWhisperAsync(string toUserId, string message, CancellationToken cancellationToken);

  /// <summary>
  /// <paramref name="durationSeconds"/> present → timeout for that many seconds (clamped to
  /// 1..1,209,600, defaulting invalid/non-positive input to 600); absent (null) → permanent ban.
  /// </summary>
  Task<Result> BanOrTimeoutAsync(string userId, int? durationSeconds, string? reason, CancellationToken cancellationToken);

  /// <summary>Resolves an AutoMod hold. A Twitch 404 (<c>BadResourceException</c> — the hold already expired/was resolved elsewhere) resolves as <see cref="AutomodOutcomes.Gone"/>, not a failure.</summary>
  Task<Result<AutomodResolution>> ResolveAutomodMessageAsync(string messageId, bool allow, CancellationToken cancellationToken);

  /// <summary>
  /// Creates a single EventSub subscription over websocket transport. Unlike
  /// <see cref="GetBroadcasterIdAsync"/>, this resolves a FRESH broadcaster token on every call
  /// rather than caching one — and, going through <see cref="TwitchLibHelixApi"/> like every
  /// other method here, it also syncs the shared <c>TwitchAPI</c> singleton's
  /// <c>Settings.ClientId</c> from AppConfig on every call. That matters specifically for
  /// resubscribe: <see cref="GetBroadcasterIdAsync"/> caches its result for the process
  /// lifetime and so does NOT resync ClientId on a repeat call, so an operator who rotates the
  /// Twitch Client ID and then hits a hard-drop EventSub reconnect (which resubscribes without
  /// ever calling <see cref="GetAuthenticatedUserAsync"/> or another Helix method first) needs
  /// subscription creation itself to be the thing that stays fresh. Returns
  /// <see cref="Result"/> (never throws, except <see cref="OperationCanceledException"/>) so a
  /// caller looping over many subscriptions can log-and-continue on one failure without
  /// aborting the batch — see <c>TwitchEventSubService.CreateSubscriptionsAsync</c>.
  /// </summary>
  Task<Result> CreateEventSubWebsocketSubscriptionAsync(
    string type, string version, IReadOnlyDictionary<string, string> condition, string sessionId, CancellationToken cancellationToken);
}
