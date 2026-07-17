using System.Text.Json;
using System.Text.Json.Serialization;

namespace Narya.Core.Realtime;

/// <summary>
/// The wire shape carried on <see cref="RealtimeChannel"/>: <c>{ "event": ..., "payload":
/// ... }</c>. Shared by the publisher and the broadcaster so both sides agree on the JSON
/// property names in exactly one place rather than duplicating string literals.
///
/// <see cref="Payload"/> is a <see cref="JsonElement"/> rather than <c>object</c>: the
/// publisher serializes the notification's payload by its RUNTIME type before it ever
/// becomes part of this envelope (see <c>Narya.Cache.RealtimePublisher</c>), so by the
/// time an envelope exists, the payload is already committed to JSON — there is no
/// static-type pitfall left to reintroduce here.
/// </summary>
public sealed record RealtimeEnvelope(
  [property: JsonPropertyName("event")] string Event,
  [property: JsonPropertyName("payload")] JsonElement Payload);
