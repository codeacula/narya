using Narya.Core.AppConfig;
using Narya.Database.AppConfig.Events;

namespace Narya.Database.AppConfig;

/// <summary>
/// Maps the client-facing <see cref="AppConfigPatch"/> (Narya.Core) onto the persisted
/// <see cref="AppConfigUpdatedEvent"/> (Narya.Database). This lives here rather than as
/// an instance method on the patch itself because Narya.Database already references
/// Narya.Core — the reverse reference needed for <c>AppConfigPatch</c> to construct an
/// <see cref="AppConfigUpdatedEvent"/> directly would make the project graph circular.
///
/// <para>
/// The patch's three secret fields are deliberately absent from <see cref="ToEvent"/> —
/// they are folded into <see cref="DbAppConfigSecrets"/> by <see cref="ToSecrets"/>
/// instead, and never enter the append-only event stream.
/// </para>
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
      ObsUrl = patch.ObsUrl,
      ObsScenePrefix = patch.ObsScenePrefix,
      DiscordClientId = patch.DiscordClientId,
      ChatterboxBaseUrl = patch.ChatterboxBaseUrl,
      MusicPollIntervalMs = patch.MusicPollIntervalMs,
      MusicPlayerctlPlayer = patch.MusicPlayerctlPlayer,
      SoundVolume = patch.SoundVolume,
    };

  /// <summary>
  /// Folds the patch's secret fields over the currently stored secrets document, honouring
  /// the same null-means-unchanged contract the event projection uses: null leaves the
  /// stored secret alone, an explicit empty string clears it. <paramref name="current"/> is
  /// null when no secret has ever been written, in which case the domain defaults apply.
  /// </summary>
  public static DbAppConfigSecrets ToSecrets(this AppConfigPatch patch, Guid id, DbAppConfigSecrets? current)
  {
    var existing = current ?? DbAppConfigSecrets.Default;

    return existing with
    {
      Id = id,
      TwitchClientSecret = patch.TwitchClientSecret ?? existing.TwitchClientSecret,
      ObsPassword = patch.ObsPassword ?? existing.ObsPassword,
      DiscordBotToken = patch.DiscordBotToken ?? existing.DiscordBotToken,
    };
  }
}
