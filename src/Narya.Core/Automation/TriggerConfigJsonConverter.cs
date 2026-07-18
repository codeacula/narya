using System.Text.Json;
using System.Text.Json.Serialization;

namespace Narya.Core.Automation;

/// <summary>
/// Hand-written discriminated-union converter for <see cref="TriggerConfig"/> — a direct sibling of
/// <c>Narya.Core.Actions.ActionStepJsonConverter</c>; see that type's doc comment for why a
/// hand-written buffer-then-dispatch converter replaces the BCL's
/// <see cref="JsonPolymorphicAttribute"/>/<see cref="JsonDerivedTypeAttribute"/> (short version:
/// Marten's storage round-trip does not guarantee the <c>"type"</c> discriminator lands first in
/// the persisted JSONB, which the BCL's polymorphic reader requires).
/// </summary>
public sealed class TriggerConfigJsonConverter : JsonConverter<TriggerConfig>
{
  public override TriggerConfig Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
  {
    using var document = JsonDocument.ParseValue(ref reader);
    var root = document.RootElement;
    if (!root.TryGetProperty("type", out var typeProperty) || typeProperty.GetString() is not { } discriminator)
    {
      throw new JsonException("A trigger config is missing its \"type\" discriminator.");
    }

    var json = root.GetRawText();
    return discriminator switch
    {
      "reward" => Deserialize<RewardTriggerConfig>(json, options),
      "twitch_event" => Deserialize<TwitchEventTriggerConfig>(json, options),
      "chat_phrase" => Deserialize<ChatPhraseTriggerConfig>(json, options),
      "viewer_command" => Deserialize<ViewerCommandTriggerConfig>(json, options),
      "dashboard_slash" => Deserialize<DashboardSlashTriggerConfig>(json, options),
      "manual" => Deserialize<ManualTriggerConfig>(json, options),
      "module_activate" => Deserialize<ModuleActivateTriggerConfig>(json, options),
      "module_deactivate" => Deserialize<ModuleDeactivateTriggerConfig>(json, options),
      _ => throw new JsonException($"Unknown trigger config type discriminator: \"{discriminator}\"."),
    };
  }

  public override void Write(Utf8JsonWriter writer, TriggerConfig value, JsonSerializerOptions options)
  {
    var (discriminator, element) = value switch
    {
      RewardTriggerConfig c => ("reward", Serialize(c, options)),
      TwitchEventTriggerConfig c => ("twitch_event", Serialize(c, options)),
      ChatPhraseTriggerConfig c => ("chat_phrase", Serialize(c, options)),
      ViewerCommandTriggerConfig c => ("viewer_command", Serialize(c, options)),
      DashboardSlashTriggerConfig c => ("dashboard_slash", Serialize(c, options)),
      ManualTriggerConfig c => ("manual", Serialize(c, options)),
      ModuleActivateTriggerConfig c => ("module_activate", Serialize(c, options)),
      ModuleDeactivateTriggerConfig c => ("module_deactivate", Serialize(c, options)),
      _ => throw new NotSupportedException($"Unsupported trigger config type: {value.GetType()}."),
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
    where T : TriggerConfig =>
    JsonSerializer.Deserialize<T>(json, options)
      ?? throw new JsonException($"A trigger config of type {typeof(T).Name} deserialized to null.");

  private static JsonElement Serialize<T>(T value, JsonSerializerOptions options)
    where T : TriggerConfig =>
    JsonSerializer.SerializeToElement(value, options);
}
