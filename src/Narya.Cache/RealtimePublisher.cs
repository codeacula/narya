using System.Text.Json;

using StackExchange.Redis;

using Narya.Core.Realtime;

namespace Narya.Cache;

/// <summary>
/// Publishes realtime event envelopes to Redis channel <see cref="RealtimeChannel.Name"/>.
/// <see cref="Narya.Api.Realtime.RealtimeBroadcastService"/> (Narya.Api) subscribes to the
/// same channel and forwards each envelope to SignalR.
/// </summary>
public sealed class RealtimePublisher(IConnectionMultiplexer multiplexer) : IRealtimePublisher
{
  internal static readonly RedisChannel Channel = RedisChannel.Literal(RealtimeChannel.Name);

  /// <summary>
  /// <see cref="JsonSerializerDefaults.Web"/> camelCases property names, matching what
  /// <c>ConfigController</c>'s <c>[ApiController]</c> JSON output already produces for the
  /// same <c>AppConfigResponse</c> shape — a client subscribed to both the REST endpoint
  /// and the realtime channel sees identically-cased payloads either way.
  /// </summary>
  private static readonly JsonSerializerOptions SerializerOptions = new(JsonSerializerDefaults.Web);

  public Task PublishAsync(string eventName, object payload, CancellationToken cancellationToken)
  {
    ArgumentNullException.ThrowIfNull(eventName);
    ArgumentNullException.ThrowIfNull(payload);
    cancellationToken.ThrowIfCancellationRequested();

    // Explicit payload.GetType() rather than JsonSerializer.SerializeToElement(payload,
    // options) — System.Text.Json happens to special-case a parameter DECLARED as
    // `object` by already resolving GetType() internally (verified empirically: removing
    // this explicit call still round-trips every property correctly), but that special
    // case is specific to the static type being literally `object` at the call site. Any
    // future refactor that routes the payload through a narrower static type (a field, a
    // helper method typed to some interface, a generic wrapper) loses that special case
    // and silently reverts to serializing by the STATIC type — which for any real base
    // type/interface (not `object` itself) drops every member the base type doesn't
    // declare. Being explicit here means this call stays correct regardless of how
    // `payload` gets here.
    var payloadElement = JsonSerializer.SerializeToElement(payload, payload.GetType(), SerializerOptions);
    var envelope = new RealtimeEnvelope(eventName, payloadElement);
    var json = JsonSerializer.Serialize(envelope, SerializerOptions);

    var subscriber = multiplexer.GetSubscriber();
    return subscriber.PublishAsync(Channel, json);
  }
}
