using System.Text.Json;
using System.Text.Json.Serialization;

using Narya.Core.Automation;

namespace Narya.Core.Tests.Automation;

/// <summary>
/// Direct unit tests for <see cref="TriggerConfigJsonConverter"/> — specifically that it does not
/// throw when a JSON payload omits <see cref="TwitchEventTriggerConfig.EventKind"/> or
/// <see cref="ChatPhraseTriggerConfig.Match"/> (both now nullable enums; see the doc comments on
/// those properties and on <see cref="AutomationTriggerValidation.NormalizeTwitchEvent"/>). Rejecting
/// an absent value is <see cref="AutomationTriggerValidation"/>'s job
/// (<c>AutomationTriggerValidationTests.TwitchEventWithAnAbsentEventKindFails</c> /
/// <c>ChatPhraseWithAnAbsentMatchFails</c>) — this converter's only job is to bind a missing property
/// to <see langword="null"/> instead of crashing, so validation is actually reached.
/// </summary>
public sealed class TriggerConfigJsonConverterTests
{
  private static readonly JsonSerializerOptions Options = new()
  {
    Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) },
  };

  [Fact]
  public void TwitchEventWithNoEventKindPropertyDeserializesToNullRatherThanThrowing()
  {
    var config = JsonSerializer.Deserialize<TriggerConfig>("""{"type":"twitch_event"}""", Options);

    var twitchEvent = Assert.IsType<TwitchEventTriggerConfig>(config);
    Assert.Null(twitchEvent.EventKind);
  }

  [Fact]
  public void TwitchEventWithAPresentEventKindSurvivesTheRoundTrip()
  {
    var written = JsonSerializer.Serialize<TriggerConfig>(new TwitchEventTriggerConfig { EventKind = TwitchAlertEventKind.Raid }, Options);
    var read = JsonSerializer.Deserialize<TriggerConfig>(written, Options);

    var twitchEvent = Assert.IsType<TwitchEventTriggerConfig>(read);
    Assert.Equal(TwitchAlertEventKind.Raid, twitchEvent.EventKind);
  }

  [Fact]
  public void ChatPhraseWithNoMatchPropertyDeserializesToNullRatherThanThrowing()
  {
    var config = JsonSerializer.Deserialize<TriggerConfig>("""{"type":"chat_phrase","phrase":"hype"}""", Options);

    var chatPhrase = Assert.IsType<ChatPhraseTriggerConfig>(config);
    Assert.Null(chatPhrase.Match);
  }

  [Fact]
  public void ChatPhraseWithAPresentMatchSurvivesTheRoundTrip()
  {
    var written = JsonSerializer.Serialize<TriggerConfig>(
      new ChatPhraseTriggerConfig { Phrase = "hype", Match = ChatPhraseMatch.Contains },
      Options);
    var read = JsonSerializer.Deserialize<TriggerConfig>(written, Options);

    var chatPhrase = Assert.IsType<ChatPhraseTriggerConfig>(read);
    Assert.Equal(ChatPhraseMatch.Contains, chatPhrase.Match);
  }
}
