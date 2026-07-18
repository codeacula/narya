using System.Text.Json;
using System.Text.Json.Serialization;

namespace Narya.Core.Actions;

/// <summary>
/// Hand-written discriminated-union converter for <see cref="ActionStep"/> — see that type's doc
/// comment for WHY this exists instead of <see cref="JsonPolymorphicAttribute"/>/
/// <see cref="JsonDerivedTypeAttribute"/> (short version: the BCL's built-in polymorphic
/// deserializer requires the <c>"type"</c> discriminator to be the FIRST JSON property, and
/// Marten's storage round-trip does not guarantee that).
///
/// <para>
/// <b>Read</b> buffers the whole step element via <see cref="JsonDocument.ParseValue"/> before
/// picking a type — this is what makes property order irrelevant, at the cost of holding one
/// step's worth of JSON in memory at a time (steps are small, bounded objects; this is not a
/// concern the way buffering an entire request body would be). The discriminator is looked up by
/// name, then the buffered element's raw text is deserialized straight into the matching CONCRETE
/// sealed record — deserializing a concrete (not abstract) type never re-enters this converter,
/// because <c>JsonConverter&lt;T&gt;.CanConvert</c>'s default implementation matches
/// <see cref="ActionStep"/> exactly, not its subtypes, so there is no risk of infinite recursion
/// despite reusing the same <c>options</c> instance.
/// </para>
///
/// <para>
/// <b>Write</b> serializes the concrete instance's own fields (same non-recursion reasoning as
/// Read) and then re-emits them with the discriminator written first — purely for readability of
/// the stored/wire JSON; Read does not depend on this ordering.
/// </para>
/// </summary>
public sealed class ActionStepJsonConverter : JsonConverter<ActionStep>
{
  public override ActionStep Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
  {
    using var document = JsonDocument.ParseValue(ref reader);
    var root = document.RootElement;
    if (!root.TryGetProperty("type", out var typeProperty) || typeProperty.GetString() is not { } discriminator)
    {
      throw new JsonException("An action step is missing its \"type\" discriminator.");
    }

    var json = root.GetRawText();
    return discriminator switch
    {
      "show_text" => Deserialize<ShowTextActionStep>(json, options),
      "play_media" => Deserialize<PlayMediaActionStep>(json, options),
      "tts_speak" => Deserialize<TtsSpeakActionStep>(json, options),
      "send_chat" => Deserialize<SendChatActionStep>(json, options),
      "llm_response" => Deserialize<LlmResponseActionStep>(json, options),
      "obs_scene" => Deserialize<ObsSceneActionStep>(json, options),
      "obs_transition" => Deserialize<ObsTransitionActionStep>(json, options),
      "twitch_shoutout" => Deserialize<TwitchShoutoutActionStep>(json, options),
      "twitch_whisper" => Deserialize<TwitchWhisperActionStep>(json, options),
      "twitch_timeout" => Deserialize<TwitchTimeoutActionStep>(json, options),
      "twitch_ban" => Deserialize<TwitchBanActionStep>(json, options),
      _ => throw new JsonException($"Unknown action step type discriminator: \"{discriminator}\"."),
    };
  }

  public override void Write(Utf8JsonWriter writer, ActionStep value, JsonSerializerOptions options)
  {
    var (discriminator, element) = value switch
    {
      ShowTextActionStep s => ("show_text", Serialize(s, options)),
      PlayMediaActionStep s => ("play_media", Serialize(s, options)),
      TtsSpeakActionStep s => ("tts_speak", Serialize(s, options)),
      SendChatActionStep s => ("send_chat", Serialize(s, options)),
      LlmResponseActionStep s => ("llm_response", Serialize(s, options)),
      ObsSceneActionStep s => ("obs_scene", Serialize(s, options)),
      ObsTransitionActionStep s => ("obs_transition", Serialize(s, options)),
      TwitchShoutoutActionStep s => ("twitch_shoutout", Serialize(s, options)),
      TwitchWhisperActionStep s => ("twitch_whisper", Serialize(s, options)),
      TwitchTimeoutActionStep s => ("twitch_timeout", Serialize(s, options)),
      TwitchBanActionStep s => ("twitch_ban", Serialize(s, options)),
      _ => throw new NotSupportedException($"Unsupported action step type: {value.GetType()}."),
    };

    writer.WriteStartObject();
    writer.WriteString("type", discriminator);
    foreach (var property in element.EnumerateObject())
    {
      property.WriteTo(writer);
    }

    writer.WriteEndObject();
  }

  private static T Deserialize<T>(string json, JsonSerializerOptions options)
    where T : ActionStep =>
    JsonSerializer.Deserialize<T>(json, options)
      ?? throw new JsonException($"An action step of type {typeof(T).Name} deserialized to null.");

  private static JsonElement Serialize<T>(T value, JsonSerializerOptions options)
    where T : ActionStep =>
    JsonSerializer.SerializeToElement(value, options);
}
