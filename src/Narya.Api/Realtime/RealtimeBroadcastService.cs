using System.Text.Json;

using Microsoft.AspNetCore.SignalR;

using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

using StackExchange.Redis;

using Narya.Core.Realtime;

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
        await HandleMessageAsync(message, stoppingToken).ConfigureAwait(false);
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

  private async Task HandleMessageAsync(ChannelMessage message, CancellationToken cancellationToken)
  {
    var raw = message.Message.ToString();
    if (string.IsNullOrEmpty(raw))
    {
      return;
    }

    RealtimeEnvelope? envelope;
    try
    {
      envelope = JsonSerializer.Deserialize<RealtimeEnvelope>(raw, SerializerOptions);
    }
    catch (JsonException ex)
    {
      LogMalformedEnvelope(logger, ex);
      return;
    }

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

  [LoggerMessage(Level = LogLevel.Warning, Message = "Dropped a malformed realtime envelope from Redis")]
  private static partial void LogMalformedEnvelope(ILogger logger, Exception exception);
}
