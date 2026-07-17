using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

using Narya.Twitch.Helix;
using Narya.Twitch.Tokens;

using TwitchLib.Api;
using TwitchLib.Api.Core.Enums;
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
  private readonly TwitchAPI _api;
  private readonly ITwitchCredentials _credentials;
  private readonly IHelixClient _helixClient;
  private readonly TimeProvider _timeProvider;
  private readonly ILogger<TwitchEventSubService> _logger;
  private readonly Lock _statusLock = new();

  private EventSubStatus _status = EventSubStatus.Initial;
  private string? _lastSubscribedSessionId;

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
    TwitchAPI api,
    ITwitchCredentials credentials,
    IHelixClient helixClient,
    TimeProvider timeProvider,
    ILogger<TwitchEventSubService> logger)
  {
    _client = client;
    _api = api;
    _credentials = credentials;
    _helixClient = helixClient;
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

    var created = await CreateSubscriptionsAsync(sessionId, _stoppingToken).ConfigureAwait(false);
    _lastSubscribedSessionId = sessionId;
    LogConnected(_logger, sessionId, created, EventSubSubscriptions.All.Count);
    UpdateStatus(status => status with { Connected = true, SessionId = sessionId, SubscriptionsCreated = created });
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

  /// <summary>
  /// Never a manual <c>DisconnectAsync</c>+<c>ConnectAsync</c> pair — TwitchLib.EventSub.Websockets
  /// issue #37 documents that sequence leaving the socket unable to start again ("WebSocket
  /// has already been started"). <see cref="EventSubWebsocketClient.ReconnectAsync()"/> is the
  /// only supported recovery path; it resolves a fresh transport from DI internally.
  /// </summary>
  private async Task ReconnectWithBackoffAsync(CancellationToken cancellationToken)
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

  /// <summary>
  /// Best-effort: one subscription Twitch rejects (a stale scope, a version it no longer
  /// accepts) must not stop the rest from being created, and must never take the socket down
  /// — twitchlib-spec.md §3's "Our BackgroundService STILL owns" list. Every failure is logged
  /// and folded into <see cref="Status"/>'s <see cref="EventSubStatus.LastError"/>; the run
  /// keeps going regardless.
  /// </summary>
  private async Task<int> CreateSubscriptionsAsync(string sessionId, CancellationToken cancellationToken)
  {
    // GetBroadcasterIdAsync is resolved first deliberately: it is itself a Helix call, and
    // Narya.Twitch.Helix.TwitchLibHelixApi syncs the shared TwitchAPI singleton's
    // Settings.ClientId from AppConfig on every call it makes — so by the time the loop
    // below calls api.Helix.EventSub.CreateEventSubSubscriptionAsync directly, ClientId is
    // already fresh even if this is the very first Helix call this process has made.
    var broadcasterIdResult = await _helixClient.GetBroadcasterIdAsync(cancellationToken).ConfigureAwait(false);
    if (broadcasterIdResult.IsFailed)
    {
      var reason = string.Join("; ", broadcasterIdResult.Errors.Select(error => error.Message));
      LogSubscriptionSetupFailed(_logger, reason);
      UpdateStatus(status => status with { LastError = reason });
      return 0;
    }

    var tokenResult = await _credentials.GetAccessTokenAsync(TwitchProvider.Broadcaster, cancellationToken).ConfigureAwait(false);
    if (tokenResult.IsFailed)
    {
      var reason = string.Join("; ", tokenResult.Errors.Select(error => error.Message));
      LogSubscriptionSetupFailed(_logger, reason);
      UpdateStatus(status => status with { LastError = reason });
      return 0;
    }

    var broadcasterId = broadcasterIdResult.Value;
    var accessToken = tokenResult.Value;
    var created = 0;

    foreach (var subscription in EventSubSubscriptions.All)
    {
      try
      {
        var condition = subscription.ConditionFor(broadcasterId);
        _ = await _api.Helix.EventSub.CreateEventSubSubscriptionAsync(
          subscription.Type,
          subscription.Version,
          condition,
          EventSubTransportMethod.Websocket,
          websocketSessionId: sessionId,
          accessToken: accessToken).ConfigureAwait(false);
        created++;
      }
      catch (OperationCanceledException)
      {
        throw;
      }
      catch (Exception ex)
      {
        LogSubscriptionCreateFailed(_logger, subscription.Type, subscription.Version, ex);
        UpdateStatus(status => status with { LastError = $"{subscription.Type} v{subscription.Version}: {ex.Message}" });
      }
    }

    return created;
  }

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

  [LoggerMessage(Level = LogLevel.Warning, Message = "Twitch EventSub subscription {Type} v{Version} failed")]
  private static partial void LogSubscriptionCreateFailed(ILogger logger, string type, string version, Exception exception);
}
