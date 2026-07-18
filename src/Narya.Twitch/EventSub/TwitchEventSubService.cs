using System.Collections.Concurrent;

using MediatR;

using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

using Narya.Twitch.EventSub.Notifications;
using Narya.Twitch.Helix;

using TwitchLib.EventSub.Core.EventArgs.Automod;
using TwitchLib.EventSub.Core.EventArgs.Channel;
using TwitchLib.EventSub.Core.EventArgs.Stream;
using TwitchLib.EventSub.Core.EventArgs.User;
using TwitchLib.EventSub.Websockets;
using TwitchLib.EventSub.Websockets.Core.EventArgs;

namespace Narya.Twitch.EventSub;

/// <summary>
/// The <see cref="BackgroundService"/> that owns the Twitch EventSub websocket's connection
/// lifecycle over the singleton <see cref="EventSubWebsocketClient"/> TwitchLib.EventSub.Websockets
/// registers via <c>AddTwitchLibEventSubWebsockets()</c> (twitchlib-spec.md §3). TwitchLib
/// itself owns keepalive-timeout detection and Twitch's own <c>session_reconnect</c> migration
/// (a dual-connect to the new URL that carries subscriptions over) — this service does NOT
/// re-implement either. What it still owns:
///
/// <list type="number">
/// <item>Creating every subscription in <see cref="EventSubSubscriptions.All"/> against Helix
/// the moment a session is ready to receive them (<see cref="OnWebsocketConnectedAsync"/>) —
/// EventSub.Websockets only RECEIVES notifications; subscription creation is a Helix call.</item>
/// <item>Deciding whether that create-all-subscriptions step is needed at all: skipped
/// entirely when <see cref="WebsocketConnectedArgs.IsRequestedReconnect"/> is set (a graceful
/// Twitch-initiated migration — the subscriptions already carried over), and otherwise gated
/// by <see cref="ShouldResubscribe"/> so an unexpected duplicate connect for the same session
/// id is not turned into duplicate Helix calls.</item>
/// <item>Recovering from a hard drop (<see cref="OnWebsocketDisconnectedAsync"/>) by calling
/// <see cref="EventSubWebsocketClient.ReconnectAsync()"/> — never a manual
/// <c>DisconnectAsync</c>+<c>ConnectAsync</c> pair, which TwitchLib.EventSub.Websockets issue
/// #37 documents as leaving the socket in a broken "already started" state — in an
/// exponential-backoff loop (<see cref="ReconnectWithBackoffAsync"/>) that keeps retrying
/// until it succeeds or the service is stopped.</item>
/// <item>Logging <see cref="EventSubWebsocketClient.Revocation"/> and
/// <see cref="EventSubWebsocketClient.ErrorOccurred"/> (the library's own spelling — one "r"
/// on the <c>ErrorOccuredArgs</c> type, though the event member itself is the correctly
/// spelled <c>ErrorOccurred</c>) without taking either down.</item>
/// </list>
///
/// The event handlers are wired once, in the constructor, directly onto the DI singleton — see
/// <see cref="TwitchEventSource"/>'s doc comment for why that makes it irrelevant whether a
/// reconnect was driven from here (a hard drop) or from there (an OAuth callback granting new
/// scopes): either way these same handlers fire and run the same decision logic.
/// </summary>
public sealed partial class TwitchEventSubService : BackgroundService
{
  /// <summary>The first retry delay in <see cref="ReconnectWithBackoffAsync"/>'s backoff sequence.</summary>
  public static readonly TimeSpan InitialBackoffDelay = TimeSpan.FromSeconds(1);

  /// <summary>The backoff sequence never waits longer than this between reconnect attempts.</summary>
  public static readonly TimeSpan MaxBackoffDelay = TimeSpan.FromMinutes(2);

  private readonly EventSubWebsocketClient _client;
  private readonly IHelixClient _helixClient;
  private readonly IServiceScopeFactory _scopeFactory;
  private readonly TimeProvider _timeProvider;
  private readonly ILogger<TwitchEventSubService> _logger;
  private readonly Lock _statusLock = new();

  private EventSubStatus _status = EventSubStatus.Initial;
  private string? _lastSubscribedSessionId;

  /// <summary>
  /// Resolved once via <see cref="IHelixClient.GetAuthenticatedUserAsync"/> and cached for the
  /// process lifetime — see <see cref="GetBotLoginAsync"/>. A failed resolution (bot account not
  /// configured yet) is NOT cached, so the very next chat message tries again rather than
  /// disabling the bot-loop guard forever because the operator connected the bot account after
  /// this service had already started.
  /// </summary>
  private string? _cachedBotLogin;

  /// <summary>
  /// The subscribe/subscription.message merge state <see cref="EventSubDispatcher"/> cannot own
  /// itself (twitchlib-spec.md §3.5: "keep a small in-memory 60s dedup map keyed by user id in
  /// the SERVICE"). Keyed by <see cref="SubscriptionMergeKey"/> (the subscriber's user id, or
  /// their lowercased username when Twitch omits the id — matches legacy's <c>subMergeKey</c>).
  /// A <see cref="ConcurrentDictionary{TKey,TValue}"/> rather than a plain dictionary because
  /// <c>ChannelSubscribe</c>/<c>ChannelSubscriptionMessage</c> notifications can arrive on
  /// different threads. Entries are never proactively swept — matching legacy's own
  /// check-on-read cleanup (<c>deleteExpiredSubs</c> runs only inside <c>takeRecentSub</c>, never
  /// on a timer) — bounded by "one entry per user who has ever subscribed this process's
  /// uptime", which is not a Phase 2 concern.
  /// </summary>
  private readonly ConcurrentDictionary<string, PendingSubscription> _pendingSubscriptions = new(StringComparer.Ordinal);

  /// <summary>
  /// Reentrancy guard for <see cref="ReconnectWithBackoffAsync"/>: 0 = no loop running, 1 = a
  /// loop already owns the reconnect. <see cref="OnWebsocketDisconnectedAsync"/> fires this
  /// fire-and-forget on every <c>WebsocketDisconnected</c>, and TwitchLib's own "Failed
  /// Ping/Pong" spurious-disconnect behavior (twitchlib-spec.md §5 gotcha #10) can raise a
  /// second one while the first backoff loop is still mid-retry. Without this guard, two
  /// concurrent loops would each eventually call the shared singleton's
  /// <see cref="EventSubWebsocketClient.ReconnectAsync()"/>, each could land its own session,
  /// and each would independently pass <see cref="ShouldResubscribe"/> — creating every
  /// subscription twice, so every redemption/chat/alert would double-fire. <c>internal</c>
  /// (rather than a private nested field) only so <c>Narya.Twitch.Tests</c> can drive the guard
  /// directly — the real <see cref="EventSubWebsocketClient"/> has no virtual members, so it
  /// cannot be substituted to observe how many loops actually call it.
  /// </summary>
  internal int _reconnecting;

  /// <summary>
  /// Set once, at the top of <see cref="ExecuteAsync"/>, before the first
  /// <see cref="EventSubWebsocketClient.ConnectAsync"/> call that could cause any of the
  /// handlers wired below to run — every handler either reads this after that assignment has
  /// already happened-before it (the handler only runs as a downstream consequence of the
  /// very call that follows the assignment) or, in the narrow boot-race case, reads the
  /// default <see cref="CancellationToken.None"/>, which is a safe never-cancels value.
  /// </summary>
  private CancellationToken _stoppingToken;

  public TwitchEventSubService(
    EventSubWebsocketClient client,
    IHelixClient helixClient,
    IServiceScopeFactory scopeFactory,
    TimeProvider timeProvider,
    ILogger<TwitchEventSubService> logger)
  {
    _client = client;
    _helixClient = helixClient;
    _scopeFactory = scopeFactory;
    _timeProvider = timeProvider;
    _logger = logger;

    // Wired once, here, onto the DI singleton client — NOT re-wired on every
    // reconnect. TwitchLib's own internal reconnect (session_reconnect) swaps the
    // underlying transport but keeps this same EventSubWebsocketClient instance, and our
    // own ReconnectWithBackoffAsync below reuses it too (never a fresh instance), so a
    // single subscription here covers every connection this process ever makes.
    _client.WebsocketConnected += OnWebsocketConnectedAsync;
    _client.WebsocketDisconnected += OnWebsocketDisconnectedAsync;
    _client.WebsocketReconnected += OnWebsocketReconnectedAsync;
    _client.ErrorOccurred += OnErrorOccurredAsync;
    _client.Revocation += OnRevocationAsync;

    // The dispatch handlers (Phase 2 Task 6): each wraps a pure EventSubDispatcher call and
    // publishes the result through a freshly scoped IMediator — see PublishNotificationAsync's
    // doc comment for why a scope is created per event rather than resolving IMediator once
    // (this service is a singleton; IMediator's default registration is scoped). Every handler
    // catches broadly and logs rather than throws: TwitchLib awaits each AsyncEventHandler in
    // turn before resuming its own receive loop, so one bad event (a null-forgiving field that
    // turned out null, a downstream MediatR handler that threw) must never take the socket down.
    _client.ChannelChatMessage += OnChatMessageAsync;
    _client.ChannelChatMessageDelete += OnChatMessageDeleteAsync;
    _client.ChannelChatClear += OnChatClearAsync;
    _client.ChannelChatClearUserMessages += OnChatClearUserMessagesAsync;
    _client.ChannelModerateV2 += OnChannelModerateAsync;
    _client.ChannelFollow += OnChannelFollowAsync;
    _client.ChannelSubscribe += OnChannelSubscribeAsync;
    _client.ChannelSubscriptionMessage += OnChannelSubscriptionMessageAsync;
    _client.ChannelSubscriptionGift += OnChannelSubscriptionGiftAsync;
    _client.ChannelCheer += OnChannelCheerAsync;
    _client.ChannelRaid += OnChannelRaidAsync;
    _client.ChannelPointsCustomRewardRedemptionAdd += OnChannelPointsCustomRewardRedemptionAddAsync;
    _client.ChannelAdBreakBegin += OnChannelAdBreakBeginAsync;
    _client.UserWhisperMessage += OnUserWhisperMessageAsync;
    _client.ChannelUpdate += OnChannelUpdateAsync;
    _client.StreamOnline += OnStreamOnlineAsync;
    _client.StreamOffline += OnStreamOfflineAsync;
    _client.AutomodMessageHoldV2 += OnAutomodMessageHoldAsync;
    _client.AutomodMessageUpdateV2 += OnAutomodMessageUpdateAsync;
  }

  /// <summary>Snapshot of the current connection state — see <see cref="EventSubStatus"/>.</summary>
  public EventSubStatus Status
  {
    get
    {
      lock (_statusLock)
      {
        return _status;
      }
    }
  }

  /// <summary>
  /// Pure decision method: re-subscribing is only necessary when the session actually
  /// changed. A graceful Twitch-initiated <c>session_reconnect</c> is already filtered out
  /// before this ever runs (<see cref="WebsocketConnectedArgs.IsRequestedReconnect"/> short-
  /// circuits <see cref="OnWebsocketConnectedAsync"/> first) — this is the second, defensive
  /// gate: without it, a spurious duplicate <c>WebsocketConnected</c> for a session we already
  /// subscribed against would re-issue every Helix subscription call for no reason.
  /// </summary>
  public static bool ShouldResubscribe(string? previousSessionId, string newSessionId) =>
    !string.Equals(previousSessionId, newSessionId, StringComparison.Ordinal);

  /// <summary>
  /// The reconnect-with-backoff delay sequence: 1s, 2s, 4s, 8s, ... capped at
  /// <see cref="MaxBackoffDelay"/>, forever — <see cref="ReconnectWithBackoffAsync"/> stops
  /// consuming it only on success or cancellation, never on exhaustion (there is no exhaustion).
  /// </summary>
  public static IEnumerable<TimeSpan> BackoffDelays()
  {
    var delay = InitialBackoffDelay;
    while (true)
    {
      yield return delay;
      var doubled = delay * 2;
      delay = doubled > MaxBackoffDelay ? MaxBackoffDelay : doubled;
    }
  }

  protected override async Task ExecuteAsync(CancellationToken stoppingToken)
  {
    _stoppingToken = stoppingToken;

    var connected = false;
    try
    {
      connected = await _client.ConnectAsync().ConfigureAwait(false);
    }
    catch (OperationCanceledException)
    {
      throw;
    }
    catch (Exception ex)
    {
      LogInitialConnectFailed(_logger, ex);
    }

    if (!connected)
    {
      UpdateStatus(status => status with { Connected = false, LastError = "Initial Twitch EventSub connect failed." });

      // ConnectAsync failing outright means the client's own keepalive-monitoring loop
      // never started (there is no live connection for it to watch), so
      // WebsocketDisconnected — the event this service otherwise hooks the backoff loop
      // off of — will never fire on its own here. Start it directly instead.
      _ = ReconnectWithBackoffAsync(stoppingToken);
    }

    try
    {
      await Task.Delay(Timeout.InfiniteTimeSpan, stoppingToken).ConfigureAwait(false);
    }
    catch (OperationCanceledException)
    {
      // Expected on shutdown.
    }
    finally
    {
      try
      {
        _ = await _client.DisconnectAsync().ConfigureAwait(false);
      }
      catch (Exception ex)
      {
        LogDisconnectFailed(_logger, ex);
      }
    }
  }

  private async Task OnWebsocketConnectedAsync(object? sender, WebsocketConnectedArgs e)
  {
    var sessionId = _client.SessionId;

    if (e.IsRequestedReconnect)
    {
      // Twitch's own session_reconnect migration — TwitchLib already carried every
      // subscription over to the new session. Recreating them here would double-fire
      // every redemption, chat message, and alert until Twitch's cost limit rejects the
      // duplicates.
      LogGracefulReconnect(_logger, sessionId);
      _lastSubscribedSessionId = sessionId;
      UpdateStatus(status => status with { Connected = true, SessionId = sessionId });
      return;
    }

    if (!ShouldResubscribe(_lastSubscribedSessionId, sessionId))
    {
      UpdateStatus(status => status with { Connected = true, SessionId = sessionId });
      return;
    }

    var outcome = await CreateSubscriptionsAsync(sessionId, _stoppingToken).ConfigureAwait(false);

    if (outcome.Attempted)
    {
      // Only mark this session "subscribed" once resolution actually got past broadcaster-id
      // lookup and the create loop ran — a bail-before-the-loop attempt (broadcaster id
      // resolution failed) must stay retryable so a duplicate WebsocketConnected for the same
      // session can try again, rather than being silently treated as handled forever.
      _lastSubscribedSessionId = sessionId;
    }

    LogConnected(_logger, sessionId, outcome.Created, EventSubSubscriptions.All.Count);
    UpdateStatus(status => status with
    {
      Connected = true,
      SessionId = sessionId,
      SubscriptionsCreated = outcome.Created,
      // Clear a stale LastError only once the batch both ran and fully succeeded — a sub
      // failure inside the loop already set a fresh, more specific LastError below, and a
      // bailed-before-the-loop attempt leaves whatever CreateSubscriptionsAsync set in place.
      LastError = outcome.Attempted && outcome.Created == EventSubSubscriptions.All.Count ? null : status.LastError,
    });
  }

  private Task OnWebsocketDisconnectedAsync(object? sender, WebsocketDisconnectedArgs e)
  {
    LogDisconnected(_logger);
    UpdateStatus(status => status with { Connected = false });

    // Fire-and-forget: TwitchLib awaits every AsyncEventHandler in turn before it resumes
    // its own internal loop, and this backoff loop can legitimately run for minutes. There
    // is nothing left to process on a disconnected socket in the meantime, so blocking the
    // library on it here would have no benefit. Every exception path inside
    // ReconnectWithBackoffAsync is already handled internally, so nothing here can become
    // an unobserved task exception.
    _ = ReconnectWithBackoffAsync(_stoppingToken);
    return Task.CompletedTask;
  }

  private Task OnWebsocketReconnectedAsync(object? sender, WebsocketReconnectedArgs e)
  {
    LogReconnected(_logger);
    return Task.CompletedTask;
  }

  private Task OnErrorOccurredAsync(object? sender, ErrorOccuredArgs e)
  {
    LogWebsocketError(_logger, e.Message, e.Exception);
    UpdateStatus(status => status with { LastError = e.Message });
    return Task.CompletedTask;
  }

  private Task OnRevocationAsync(object? sender, RevocationArgs e)
  {
    var subscription = e.Payload?.Subscription;
    LogRevocation(_logger, subscription?.Type ?? "unknown", subscription?.Status ?? "unknown");
    return Task.CompletedTask;
  }

  // ---------------------------------------------------------------------------------------
  // Dispatch handlers (Phase 2 Task 6). Each is a thin shell around a pure
  // EventSubDispatcher call: build `now`, call the dispatcher, publish the result (if any —
  // several dispatch methods return null for "nothing to publish", e.g. the chat bot-loop
  // guard or a gift subscribe) through PublishNotificationAsync. `internal` (rather than
  // `private`) for the same reason as ReconnectWithBackoffAsync/CreateSubscriptionsAsync
  // above: EventSubWebsocketClient has no virtual members, so a test cannot raise a real
  // ChannelChatMessage event on it — invoking these handlers directly, with a canned *Args
  // POCO and a substituted IServiceScopeFactory, is the only way to exercise the wiring.
  // ---------------------------------------------------------------------------------------

  internal async Task OnChatMessageAsync(object? sender, ChannelChatMessageArgs e)
  {
    try
    {
      var botLogin = await GetBotLoginAsync(_stoppingToken).ConfigureAwait(false);
      var notification = EventSubDispatcher.DispatchChatMessage(e, botLogin, _timeProvider.GetUtcNow());
      if (notification is not null)
      {
        await PublishNotificationAsync(notification, _stoppingToken).ConfigureAwait(false);
      }
    }
    catch (Exception ex)
    {
      LogEventHandlerFailed(_logger, nameof(OnChatMessageAsync), ex);
    }
  }

  internal async Task OnChatMessageDeleteAsync(object? sender, ChannelChatMessageDeleteArgs e)
  {
    try
    {
      var notification = EventSubDispatcher.DispatchChatMessageDelete(e, _timeProvider.GetUtcNow());
      await PublishNotificationAsync(notification, _stoppingToken).ConfigureAwait(false);
    }
    catch (Exception ex)
    {
      LogEventHandlerFailed(_logger, nameof(OnChatMessageDeleteAsync), ex);
    }
  }

  internal async Task OnChatClearAsync(object? sender, ChannelChatClearArgs e)
  {
    try
    {
      var notification = EventSubDispatcher.DispatchChatClear(e, _timeProvider.GetUtcNow());
      await PublishNotificationAsync(notification, _stoppingToken).ConfigureAwait(false);
    }
    catch (Exception ex)
    {
      LogEventHandlerFailed(_logger, nameof(OnChatClearAsync), ex);
    }
  }

  internal async Task OnChatClearUserMessagesAsync(object? sender, ChannelChatClearUserMessagesArgs e)
  {
    try
    {
      var notification = EventSubDispatcher.DispatchChatClearUserMessages(e, _timeProvider.GetUtcNow());
      await PublishNotificationAsync(notification, _stoppingToken).ConfigureAwait(false);
    }
    catch (Exception ex)
    {
      LogEventHandlerFailed(_logger, nameof(OnChatClearUserMessagesAsync), ex);
    }
  }

  internal async Task OnChannelModerateAsync(object? sender, ChannelModerateV2Args e)
  {
    try
    {
      var notification = EventSubDispatcher.DispatchModerate(e, _timeProvider.GetUtcNow());
      if (notification is not null)
      {
        await PublishNotificationAsync(notification, _stoppingToken).ConfigureAwait(false);
      }
    }
    catch (Exception ex)
    {
      LogEventHandlerFailed(_logger, nameof(OnChannelModerateAsync), ex);
    }
  }

  internal async Task OnChannelFollowAsync(object? sender, ChannelFollowArgs e)
  {
    try
    {
      var notification = EventSubDispatcher.DispatchFollow(e, _timeProvider.GetUtcNow());
      await PublishNotificationAsync(notification, _stoppingToken).ConfigureAwait(false);
    }
    catch (Exception ex)
    {
      LogEventHandlerFailed(_logger, nameof(OnChannelFollowAsync), ex);
    }
  }

  /// <summary>
  /// Remembers this subscribe in <see cref="_pendingSubscriptions"/> BEFORE publishing, so a
  /// <c>channel.subscription.message</c> that arrives while the publish is still in flight
  /// (MediatR handlers run synchronously relative to this await, but a future handler could
  /// yield) still finds the pending entry — see <see cref="OnChannelSubscriptionMessageAsync"/>.
  /// </summary>
  internal async Task OnChannelSubscribeAsync(object? sender, ChannelSubscribeArgs e)
  {
    try
    {
      var now = _timeProvider.GetUtcNow();
      var notification = EventSubDispatcher.DispatchSubscribe(e, now);
      if (notification is null)
      {
        // Gift-sub recipient — channel.subscription.gift is the notification for this.
        return;
      }

      var key = SubscriptionMergeKey(e.Payload.Event.UserId, e.Payload.Event.UserName);
      _pendingSubscriptions[key] = new PendingSubscription(notification.Event.Id, now, HasMessage: false);

      await PublishNotificationAsync(notification, _stoppingToken).ConfigureAwait(false);
    }
    catch (Exception ex)
    {
      LogEventHandlerFailed(_logger, nameof(OnChannelSubscribeAsync), ex);
    }
  }

  /// <summary>
  /// The subscribe/subscription.message merge (twitchlib-spec.md §3.5): looks up
  /// <see cref="_pendingSubscriptions"/> for this subscriber and, if a subscribe landed within
  /// <see cref="EventSubDispatcher.SubscriptionMergeWindow"/> (the pure decision is
  /// <see cref="EventSubDispatcher.ShouldMergeSubscriptionMessage"/>) and has not already been
  /// merged into once, updates that stream event instead of emitting a second one. Otherwise —
  /// no pending entry, the window lapsed, or this is a duplicate message notification for a
  /// resub already merged — falls through to a brand-new stream event (the monthly-resub case,
  /// where Twitch never fires <c>channel.subscribe</c> at all).
  /// </summary>
  internal async Task OnChannelSubscriptionMessageAsync(object? sender, ChannelSubscriptionMessageArgs e)
  {
    try
    {
      var now = _timeProvider.GetUtcNow();
      var key = SubscriptionMergeKey(e.Payload.Event.UserId, e.Payload.Event.UserName);

      if (_pendingSubscriptions.TryGetValue(key, out var pending)
        && EventSubDispatcher.ShouldMergeSubscriptionMessage(pending.SubscribedAt, now))
      {
        if (pending.HasMessage)
        {
          // A duplicate subscription.message notification for a resub already merged.
          return;
        }

        var update = EventSubDispatcher.DispatchSubscriptionMessageAsMerge(e, pending.StreamEventId);
        _pendingSubscriptions[key] = pending with { HasMessage = true };
        await PublishNotificationAsync(update, _stoppingToken).ConfigureAwait(false);
        return;
      }

      var notification = EventSubDispatcher.DispatchSubscriptionMessageAsNewEvent(e, now);
      _pendingSubscriptions[key] = new PendingSubscription(notification.Event.Id, now, HasMessage: true);
      await PublishNotificationAsync(notification, _stoppingToken).ConfigureAwait(false);
    }
    catch (Exception ex)
    {
      LogEventHandlerFailed(_logger, nameof(OnChannelSubscriptionMessageAsync), ex);
    }
  }

  internal async Task OnChannelSubscriptionGiftAsync(object? sender, ChannelSubscriptionGiftArgs e)
  {
    try
    {
      var notification = EventSubDispatcher.DispatchGift(e, _timeProvider.GetUtcNow());
      await PublishNotificationAsync(notification, _stoppingToken).ConfigureAwait(false);
    }
    catch (Exception ex)
    {
      LogEventHandlerFailed(_logger, nameof(OnChannelSubscriptionGiftAsync), ex);
    }
  }

  internal async Task OnChannelCheerAsync(object? sender, ChannelCheerArgs e)
  {
    try
    {
      var notification = EventSubDispatcher.DispatchCheer(e, _timeProvider.GetUtcNow());
      await PublishNotificationAsync(notification, _stoppingToken).ConfigureAwait(false);
    }
    catch (Exception ex)
    {
      LogEventHandlerFailed(_logger, nameof(OnChannelCheerAsync), ex);
    }
  }

  internal async Task OnChannelRaidAsync(object? sender, ChannelRaidArgs e)
  {
    try
    {
      var notification = EventSubDispatcher.DispatchRaid(e, _timeProvider.GetUtcNow());
      await PublishNotificationAsync(notification, _stoppingToken).ConfigureAwait(false);
    }
    catch (Exception ex)
    {
      LogEventHandlerFailed(_logger, nameof(OnChannelRaidAsync), ex);
    }
  }

  internal async Task OnChannelPointsCustomRewardRedemptionAddAsync(object? sender, ChannelPointsCustomRewardRedemptionArgs e)
  {
    try
    {
      var notification = EventSubDispatcher.DispatchRedemption(e, _timeProvider.GetUtcNow());
      await PublishNotificationAsync(notification, _stoppingToken).ConfigureAwait(false);
    }
    catch (Exception ex)
    {
      LogEventHandlerFailed(_logger, nameof(OnChannelPointsCustomRewardRedemptionAddAsync), ex);
    }
  }

  internal async Task OnChannelAdBreakBeginAsync(object? sender, ChannelAdBreakBeginArgs e)
  {
    try
    {
      var notification = EventSubDispatcher.DispatchAdBreak(e, _timeProvider.GetUtcNow());
      await PublishNotificationAsync(notification, _stoppingToken).ConfigureAwait(false);
    }
    catch (Exception ex)
    {
      LogEventHandlerFailed(_logger, nameof(OnChannelAdBreakBeginAsync), ex);
    }
  }

  /// <summary>Operator-only — <see cref="WhisperReceivedNotification"/>'s doc comment covers why this never reaches an overlay.</summary>
  internal async Task OnUserWhisperMessageAsync(object? sender, UserWhisperMessageArgs e)
  {
    try
    {
      var notification = EventSubDispatcher.DispatchWhisper(e, _timeProvider.GetUtcNow());
      await PublishNotificationAsync(notification, _stoppingToken).ConfigureAwait(false);
    }
    catch (Exception ex)
    {
      LogEventHandlerFailed(_logger, nameof(OnUserWhisperMessageAsync), ex);
    }
  }

  /// <summary>No-op today — <see cref="CategorySignalNotification"/>'s doc comment covers why (Phase 8 wires a consumer).</summary>
  internal async Task OnChannelUpdateAsync(object? sender, ChannelUpdateArgs e)
  {
    try
    {
      var notification = EventSubDispatcher.DispatchChannelUpdate(e);
      await PublishNotificationAsync(notification, _stoppingToken).ConfigureAwait(false);
    }
    catch (Exception ex)
    {
      LogEventHandlerFailed(_logger, nameof(OnChannelUpdateAsync), ex);
    }
  }

  /// <summary>No-op today — Phase 3 wires a consumer for stream-session tracking.</summary>
  internal async Task OnStreamOnlineAsync(object? sender, StreamOnlineArgs e)
  {
    try
    {
      var notification = EventSubDispatcher.DispatchStreamOnline(e);
      await PublishNotificationAsync(notification, _stoppingToken).ConfigureAwait(false);
    }
    catch (Exception ex)
    {
      LogEventHandlerFailed(_logger, nameof(OnStreamOnlineAsync), ex);
    }
  }

  /// <summary>No-op today — Phase 3 wires a consumer for stream-session tracking.</summary>
  internal async Task OnStreamOfflineAsync(object? sender, StreamOfflineArgs e)
  {
    try
    {
      var notification = EventSubDispatcher.DispatchStreamOffline(e);
      await PublishNotificationAsync(notification, _stoppingToken).ConfigureAwait(false);
    }
    catch (Exception ex)
    {
      LogEventHandlerFailed(_logger, nameof(OnStreamOfflineAsync), ex);
    }
  }

  /// <summary>No-op today — Phase 3 wires a consumer for the AutoMod held-message queue.</summary>
  internal async Task OnAutomodMessageHoldAsync(object? sender, AutomodMessageHoldV2Args e)
  {
    try
    {
      var notification = EventSubDispatcher.DispatchAutomodHold(e);
      await PublishNotificationAsync(notification, _stoppingToken).ConfigureAwait(false);
    }
    catch (Exception ex)
    {
      LogEventHandlerFailed(_logger, nameof(OnAutomodMessageHoldAsync), ex);
    }
  }

  /// <summary>No-op today — Phase 3 wires a consumer for the AutoMod held-message queue.</summary>
  internal async Task OnAutomodMessageUpdateAsync(object? sender, AutomodMessageUpdateV2Args e)
  {
    try
    {
      var notification = EventSubDispatcher.DispatchAutomodUpdate(e);
      await PublishNotificationAsync(notification, _stoppingToken).ConfigureAwait(false);
    }
    catch (Exception ex)
    {
      LogEventHandlerFailed(_logger, nameof(OnAutomodMessageUpdateAsync), ex);
    }
  }

  /// <summary>
  /// Resolves the bot account's login once via Helix and caches it for the process lifetime —
  /// see <see cref="_cachedBotLogin"/>'s doc comment for why a failed resolution is not cached.
  /// Used only for <see cref="OnChatMessageAsync"/>'s bot-loop guard; a bot token that is never
  /// configured means this simply never short-circuits (every chat message is treated as a
  /// viewer's), matching "no bot configured" degrading safely rather than silently.
  /// </summary>
  internal async Task<string?> GetBotLoginAsync(CancellationToken cancellationToken)
  {
    if (!string.IsNullOrEmpty(_cachedBotLogin))
    {
      return _cachedBotLogin;
    }

    var result = await _helixClient.GetAuthenticatedUserAsync(TwitchProvider.Bot, cancellationToken).ConfigureAwait(false);
    if (result.IsFailed)
    {
      return null;
    }

    _cachedBotLogin = result.Value.Login.ToLowerInvariant();
    return _cachedBotLogin;
  }

  /// <summary>
  /// This service is a registered singleton (one instance for the process lifetime), but
  /// <see cref="IMediator"/>'s default MediatR registration is scoped — resolving it once in
  /// the constructor and holding onto it would either fail outright or (depending on how the
  /// root container is configured) silently capture a scope that outlives every request it was
  /// ever meant to be scoped to. A fresh <see cref="IServiceScope"/> per event keeps every
  /// downstream MediatR handler (and anything scoped it resolves, e.g. a scoped DbContext a
  /// later phase's handler might need) on the same footing as a normal HTTP request.
  /// </summary>
  private async Task PublishNotificationAsync(INotification notification, CancellationToken cancellationToken)
  {
    using var scope = _scopeFactory.CreateScope();
    var mediator = scope.ServiceProvider.GetRequiredService<IMediator>();
    await mediator.Publish(notification, cancellationToken).ConfigureAwait(false);
  }

  /// <summary>Matches legacy's <c>subMergeKey</c>: prefer the subscriber's user id, falling back to their lowercased username when Twitch omits it.</summary>
  private static string SubscriptionMergeKey(string userId, string userName) =>
    !string.IsNullOrEmpty(userId) ? userId : userName.ToLowerInvariant();

  /// <summary>
  /// <paramref name="HasMessage"/> mirrors legacy's <c>sub_merge_state.has_message</c>: distinguishes
  /// "a subscribe is waiting for its resub message" from "already merged once" so a genuine
  /// duplicate <c>channel.subscription.message</c> redelivery for the same resub is dropped
  /// rather than updating the same stream event's detail a second time.
  /// </summary>
  internal readonly record struct PendingSubscription(string StreamEventId, DateTimeOffset SubscribedAt, bool HasMessage);

  /// <summary>
  /// Never a manual <c>DisconnectAsync</c>+<c>ConnectAsync</c> pair — TwitchLib.EventSub.Websockets
  /// issue #37 documents that sequence leaving the socket unable to start again ("WebSocket
  /// has already been started"). <see cref="EventSubWebsocketClient.ReconnectAsync()"/> is the
  /// only supported recovery path; it resolves a fresh transport from DI internally.
  ///
  /// Guarded by <see cref="_reconnecting"/> so only one loop ever runs at a time: a second
  /// <c>WebsocketDisconnected</c> firing while a loop is already in flight (see that field's
  /// doc comment) is a no-op here rather than a second concurrent backoff loop racing the
  /// first one's calls to the shared <see cref="EventSubWebsocketClient"/> singleton.
  /// <c>internal</c> (rather than <c>private</c>) only so tests can drive it directly — see
  /// <see cref="_reconnecting"/>'s doc comment for why the real client can't be substituted to
  /// observe this from the outside.
  /// </summary>
  internal async Task ReconnectWithBackoffAsync(CancellationToken cancellationToken)
  {
    if (Interlocked.CompareExchange(ref _reconnecting, 1, 0) != 0)
    {
      return;
    }

    try
    {
      foreach (var delay in BackoffDelays())
      {
        if (cancellationToken.IsCancellationRequested)
        {
          return;
        }

        try
        {
          if (await _client.ReconnectAsync().ConfigureAwait(false))
          {
            // Success — OnWebsocketConnectedAsync (wired in the constructor, onto this
            // same client) takes it from here: it reads the new SessionId and decides
            // whether to re-subscribe.
            return;
          }

          LogReconnectAttemptFailed(_logger, null);
        }
        catch (OperationCanceledException)
        {
          return;
        }
        catch (Exception ex)
        {
          LogReconnectAttemptFailed(_logger, ex);
        }

        try
        {
          await Task.Delay(delay, _timeProvider, cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
          return;
        }
      }
    }
    finally
    {
      _ = Interlocked.Exchange(ref _reconnecting, 0);
    }
  }

  /// <summary>
  /// Best-effort: one subscription Twitch rejects (a stale scope, a version it no longer
  /// accepts) must not stop the rest from being created, and must never take the socket down
  /// — twitchlib-spec.md §3's "Our BackgroundService STILL owns" list. Every failure is logged
  /// and folded into <see cref="Status"/>'s <see cref="EventSubStatus.LastError"/>; the run
  /// keeps going regardless.
  ///
  /// <see cref="SubscriptionCreationOutcome.Attempted"/> distinguishes "bailed before the loop"
  /// (broadcaster id resolution failed — nothing was attempted) from "the loop ran" (even if
  /// some/all individual subscriptions failed inside it) — see
  /// <see cref="OnWebsocketConnectedAsync"/>'s use of it to decide whether to update
  /// <see cref="_lastSubscribedSessionId"/>. <c>internal</c> (rather than <c>private</c>) only
  /// so tests can drive it directly against a substituted <see cref="IHelixClient"/> — the same
  /// reasoning as <see cref="ReconnectWithBackoffAsync"/>'s accessibility.
  /// </summary>
  internal async Task<SubscriptionCreationOutcome> CreateSubscriptionsAsync(string sessionId, CancellationToken cancellationToken)
  {
    var broadcasterIdResult = await _helixClient.GetBroadcasterIdAsync(cancellationToken).ConfigureAwait(false);
    if (broadcasterIdResult.IsFailed)
    {
      var reason = string.Join("; ", broadcasterIdResult.Errors.Select(error => error.Message));
      LogSubscriptionSetupFailed(_logger, reason);
      UpdateStatus(status => status with { LastError = reason });
      return new SubscriptionCreationOutcome(Attempted: false, Created: 0);
    }

    var broadcasterId = broadcasterIdResult.Value;
    var created = 0;

    foreach (var subscription in EventSubSubscriptions.All)
    {
      try
      {
        var condition = subscription.ConditionFor(broadcasterId);

        // Routed through IHelixClient (not a raw api.Helix.EventSub call) specifically so
        // every subscription resolves its own fresh broadcaster token and re-syncs
        // Settings.ClientId — GetBroadcasterIdAsync above is cached for the process lifetime
        // and would NOT pick up a Client ID an operator rotated in Settings after the first
        // connect. See CreateEventSubWebsocketSubscriptionAsync's doc comment.
        var subscriptionResult = await _helixClient.CreateEventSubWebsocketSubscriptionAsync(
          subscription.Type, subscription.Version, condition, sessionId, cancellationToken).ConfigureAwait(false);

        if (subscriptionResult.IsSuccess)
        {
          created++;
        }
        else
        {
          var reason = string.Join("; ", subscriptionResult.Errors.Select(error => error.Message));
          LogSubscriptionCreateFailed(_logger, subscription.Type, subscription.Version, reason);
          UpdateStatus(status => status with { LastError = $"{subscription.Type} v{subscription.Version}: {reason}" });
        }
      }
      catch (OperationCanceledException)
      {
        throw;
      }
      catch (Exception ex)
      {
        // Defensive only — IHelixClient.CreateEventSubWebsocketSubscriptionAsync maps every
        // non-cancellation exception to Result.Fail itself, so this should not normally run.
        LogSubscriptionCreateFailed(_logger, subscription.Type, subscription.Version, ex.Message);
        UpdateStatus(status => status with { LastError = $"{subscription.Type} v{subscription.Version}: {ex.Message}" });
      }
    }

    return new SubscriptionCreationOutcome(Attempted: true, Created: created);
  }

  internal readonly record struct SubscriptionCreationOutcome(bool Attempted, int Created);

  private void UpdateStatus(Func<EventSubStatus, EventSubStatus> update)
  {
    lock (_statusLock)
    {
      _status = update(_status);
    }
  }

  [LoggerMessage(Level = LogLevel.Warning, Message = "Initial Twitch EventSub connect failed")]
  private static partial void LogInitialConnectFailed(ILogger logger, Exception exception);

  [LoggerMessage(Level = LogLevel.Warning, Message = "Failed to disconnect the Twitch EventSub websocket during shutdown")]
  private static partial void LogDisconnectFailed(ILogger logger, Exception exception);

  [LoggerMessage(Level = LogLevel.Information, Message = "Twitch EventSub connected: session {SessionId}, created {Created}/{Total} subscriptions")]
  private static partial void LogConnected(ILogger logger, string sessionId, int created, int total);

  [LoggerMessage(Level = LogLevel.Information, Message = "Twitch EventSub session migrated gracefully to {SessionId}; subscriptions carried over")]
  private static partial void LogGracefulReconnect(ILogger logger, string sessionId);

  [LoggerMessage(Level = LogLevel.Warning, Message = "Twitch EventSub websocket disconnected; reconnecting with backoff")]
  private static partial void LogDisconnected(ILogger logger);

  [LoggerMessage(Level = LogLevel.Information, Message = "Twitch EventSub websocket reconnected")]
  private static partial void LogReconnected(ILogger logger);

  [LoggerMessage(Level = LogLevel.Warning, Message = "Twitch EventSub reconnect attempt failed; retrying")]
  private static partial void LogReconnectAttemptFailed(ILogger logger, Exception? exception);

  [LoggerMessage(Level = LogLevel.Error, Message = "Twitch EventSub websocket error: {Message}")]
  private static partial void LogWebsocketError(ILogger logger, string message, Exception exception);

  [LoggerMessage(Level = LogLevel.Warning, Message = "Twitch revoked EventSub subscription {Type} ({Status})")]
  private static partial void LogRevocation(ILogger logger, string type, string status);

  [LoggerMessage(Level = LogLevel.Warning, Message = "Could not create Twitch EventSub subscriptions: {Reason}")]
  private static partial void LogSubscriptionSetupFailed(ILogger logger, string reason);

  [LoggerMessage(Level = LogLevel.Warning, Message = "Twitch EventSub subscription {Type} v{Version} failed: {Reason}")]
  private static partial void LogSubscriptionCreateFailed(ILogger logger, string type, string version, string reason);

  [LoggerMessage(Level = LogLevel.Warning, Message = "Twitch EventSub dispatch handler {Handler} failed while processing an event")]
  private static partial void LogEventHandlerFailed(ILogger logger, string handler, Exception exception);
}
