using System.Runtime.CompilerServices;
using System.Text.Json;

using Microsoft.AspNetCore.SignalR;

using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

using StackExchange.Redis;

using Narya.Core.Realtime;

// HandleMessageAsync is internal (not private) solely so RealtimeBroadcastServiceTests can
// drive it directly with a substituted IHubContext<RealtimeHub> whose Clients.Group(...)
// .SendAsync(...) throws — proving a per-message forwarding failure is swallowed rather
// than propagating out of ExecuteAsync and taking down the whole host.
[assembly: InternalsVisibleTo("Narya.Api.Tests")]

namespace Narya.Api.Realtime;

/// <summary>
/// Subscribes to the Redis channel every <see cref="IRealtimePublisher"/> publish lands
/// on (<see cref="RealtimeChannel.Name"/>) and forwards each envelope to connected SignalR
/// clients. This is the only consumer of that channel in this process —
/// <see cref="RealtimeHub"/> itself never touches Redis, so a client that never opens the
/// hub connection has no way to observe realtime traffic, and a client that does gets
/// exactly what <see cref="RealtimeRouting.GroupsFor"/> routes to its group.
/// </summary>
public sealed partial class RealtimeBroadcastService(
  IConnectionMultiplexer multiplexer,
  IHubContext<RealtimeHub> hubContext,
  ILogger<RealtimeBroadcastService> logger) : BackgroundService
{
  /// <summary>The client method every forwarded envelope invokes: <c>event(eventName, payload)</c>.</summary>
  private const string ClientMethodName = "event";

  private static readonly JsonSerializerOptions SerializerOptions = new(JsonSerializerDefaults.Web);

  protected override async Task ExecuteAsync(CancellationToken stoppingToken)
  {
    var subscriber = multiplexer.GetSubscriber();
    var queue = await subscriber.SubscribeAsync(RedisChannel.Literal(RealtimeChannel.Name)).ConfigureAwait(false);

    try
    {
      await foreach (var message in queue.WithCancellation(stoppingToken).ConfigureAwait(false))
      {
        await HandleMessageAsync(message.Message.ToString(), stoppingToken).ConfigureAwait(false);
      }
    }
    catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
    {
      // Normal shutdown — the host is stopping.
    }
    finally
    {
      await queue.UnsubscribeAsync().ConfigureAwait(false);
    }
  }

  /// <summary>
  /// Processes one Redis message end to end (deserialize, route, forward to SignalR).
  /// Takes the raw <see cref="RedisValue"/> text rather than the
  /// <see cref="ChannelMessage"/> struct itself (whose constructor is internal to
  /// StackExchange.Redis and so cannot be built from a test) — <c>internal</c> so
  /// <c>RealtimeBroadcastServiceTests</c> can drive it directly.
  ///
  /// The ENTIRE body is guarded by a single try/catch: a per-message failure here —
  /// malformed JSON, or a transient SignalR/transport error from <c>SendAsync</c> — must
  /// never escape this method. <see cref="ExecuteAsync"/>'s only catch is for
  /// cancellation on shutdown; anything else propagating out of the <c>await foreach</c>
  /// loop is an unhandled exception from a <see cref="BackgroundService"/>, and the
  /// default <c>BackgroundServiceExceptionBehavior.StopHost</c> would stop the entire
  /// <c>IHost</c> — every endpoint, not just realtime — over a single unforwardable
  /// message.
  /// </summary>
  internal async Task HandleMessageAsync(string? raw, CancellationToken cancellationToken)
  {
    if (string.IsNullOrEmpty(raw))
    {
      return;
    }

    try
    {
      var envelope = JsonSerializer.Deserialize<RealtimeEnvelope>(raw, SerializerOptions);
      if (envelope is null || string.IsNullOrEmpty(envelope.Event))
      {
        return;
      }

      foreach (var group in RealtimeRouting.GroupsFor(envelope.Event))
      {
        await hubContext.Clients.Group(group)
          .SendAsync(ClientMethodName, envelope.Event, envelope.Payload, cancellationToken)
          .ConfigureAwait(false);
      }
    }
    catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
    {
      // Genuine shutdown, not a per-message failure — rethrow so ExecuteAsync's own
      // catch (and the `await foreach`'s cancellation) ends the loop instead of this
      // method swallowing it and the service spinning on a cancelled connection.
      throw;
    }
    catch (JsonException ex)
    {
      LogMalformedEnvelope(logger, ex);
    }
    catch (Exception ex)
    {
      LogBroadcastFailed(logger, ex);
    }
  }

  [LoggerMessage(Level = LogLevel.Warning, Message = "Dropped a malformed realtime envelope from Redis")]
  private static partial void LogMalformedEnvelope(ILogger logger, Exception exception);

  [LoggerMessage(Level = LogLevel.Error, Message = "Failed to forward a realtime envelope to SignalR clients")]
  private static partial void LogBroadcastFailed(ILogger logger, Exception exception);
}
