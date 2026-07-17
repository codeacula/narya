using Narya.Core.AppConfig;
using Narya.Database.AppConfig.Events;

namespace Narya.Database.AppConfig;

/// <summary>
/// Maps the client-facing <see cref="AppConfigPatch"/> (Narya.Core) onto the persisted
/// <see cref="AppConfigUpdatedEvent"/> (Narya.Database). This lives here rather than as
/// an instance method on the patch itself because Narya.Database already references
/// Narya.Core — the reverse reference needed for <c>AppConfigPatch</c> to construct an
/// <see cref="AppConfigUpdatedEvent"/> directly would make the project graph circular.
/// </summary>
public static class AppConfigPatchExtensions
{
  public static AppConfigUpdatedEvent ToEvent(this AppConfigPatch patch, Guid eventId, DateTimeOffset occurredAt) =>
    new()
    {
      EventId = eventId,
      OccurredAt = occurredAt,
      TwitchChannel = patch.TwitchChannel,
      TwitchClientId = patch.TwitchClientId,
      TwitchClientSecret = patch.TwitchClientSecret,
      ObsUrl = patch.ObsUrl,
      ObsPassword = patch.ObsPassword,
      ObsScenePrefix = patch.ObsScenePrefix,
      DiscordClientId = patch.DiscordClientId,
      DiscordBotToken = patch.DiscordBotToken,
      ChatterboxBaseUrl = patch.ChatterboxBaseUrl,
      MusicPollIntervalMs = patch.MusicPollIntervalMs,
      MusicPlayerctlPlayer = patch.MusicPlayerctlPlayer,
      SoundVolume = patch.SoundVolume,
    };
}
