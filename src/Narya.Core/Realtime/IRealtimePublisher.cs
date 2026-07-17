namespace Narya.Core.Realtime;

/// <summary>
/// Publishes a realtime event envelope to the cross-process broadcast channel (Redis
/// pub/sub in production, see <c>Narya.Cache.RealtimePublisher</c>). Declared in Core —
/// not Cache — so <c>Narya.Application.Realtime.RealtimeBridgeHandler{T}</c> can depend
/// on the abstraction without the application layer taking a reference on
/// StackExchange.Redis.
///
/// <paramref name="payload"/> is typed <c>object</c> deliberately: callers pass whatever
/// notification payload they have (e.g. the masked <c>AppConfigResponse</c>). The
/// implementation serializes by the payload's runtime type (<c>payload.GetType()</c>),
/// not the parameter's static <c>object</c> type. System.Text.Json's classic pitfall —
/// serializing by a value's static/declared type and silently dropping every member a
/// base type or interface doesn't declare — is specifically NOT triggered by a plain
/// `object`-declared parameter (System.Text.Json resolves the runtime type for that case
/// on its own), but IS triggered the moment the payload passes through any narrower
/// static type before reaching the serializer. Calling <c>GetType()</c> explicitly keeps
/// this correct independent of that internal special case.
/// </summary>
public interface IRealtimePublisher
{
  Task PublishAsync(string eventName, object payload, CancellationToken cancellationToken);
}
