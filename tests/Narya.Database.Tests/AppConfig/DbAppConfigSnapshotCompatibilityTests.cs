using System.Text.Json;

using Narya.Database.AppConfig;

namespace Narya.Database.Tests.AppConfig;

/// <summary>
/// Locks in the fix for the review finding that <see cref="DbAppConfig"/>'s property
/// initializers were bare literals (<c>""</c>/<c>0</c>) rather than the domain defaults.
/// Those initializers are NOT dead code even though <see cref="DbAppConfig.Default"/>
/// already sets every current property explicitly: they are what a JSON snapshot document
/// that predates a field deserializes to for that field, because the deserializer only
/// ever sets properties actually present in the document and otherwise leaves the
/// property's own initializer value in place.
///
/// This test simulates that scenario directly against <see cref="JsonSerializer"/> (the
/// same BCL deserializer Marten's default <c>SystemTextJsonSerializer</c> is built on)
/// rather than standing up a real Postgres/Marten snapshot with a second schema version —
/// which the record's single current shape cannot represent — so it targets the exact
/// fallback mechanism the fix depends on: a property absent from the source JSON must
/// resolve to the DOMAIN default, not the CLR default.
/// </summary>
public sealed class DbAppConfigSnapshotCompatibilityTests
{
  private static readonly JsonSerializerOptions Options = new() { PropertyNameCaseInsensitive = true };

  [Fact]
  public void FieldMissingFromAnOldSnapshotDeserializesToTheDomainDefaultNotTheClrDefault()
  {
    // Deliberately omits MusicPollIntervalMs (a numeric field whose CLR default, 0ms,
    // would be a hot polling loop) and SoundVolume, standing in for a snapshot document
    // written before those fields existed.
    const string oldSnapshotJson = """{"Id":"11111111-1111-1111-1111-111111111111","TwitchChannel":"codeacula"}""";

    var deserialized = JsonSerializer.Deserialize<DbAppConfig>(oldSnapshotJson, Options);

    Assert.NotNull(deserialized);
    Assert.Equal("codeacula", deserialized.TwitchChannel); // present in the document
    Assert.Equal(DbAppConfig.Default.MusicPollIntervalMs, deserialized.MusicPollIntervalMs); // absent: domain default
    Assert.Equal(DbAppConfig.Default.SoundVolume, deserialized.SoundVolume); // absent: domain default
    Assert.Equal(DbAppConfig.Default.ObsUrl, deserialized.ObsUrl); // absent: domain default
    Assert.Equal(DbAppConfig.Default.ObsScenePrefix, deserialized.ObsScenePrefix); // absent: domain default
  }

  [Fact]
  public void EmptyDocumentDeserializesToEveryDomainDefault()
  {
    var deserialized = JsonSerializer.Deserialize<DbAppConfig>("{}", Options);

    Assert.NotNull(deserialized);
    Assert.Equal(DbAppConfig.Default.TwitchChannel, deserialized.TwitchChannel);
    Assert.Equal(DbAppConfig.Default.TwitchClientId, deserialized.TwitchClientId);
    Assert.Equal(DbAppConfig.Default.TwitchClientSecret, deserialized.TwitchClientSecret);
    Assert.Equal(DbAppConfig.Default.ObsUrl, deserialized.ObsUrl);
    Assert.Equal(DbAppConfig.Default.ObsPassword, deserialized.ObsPassword);
    Assert.Equal(DbAppConfig.Default.ObsScenePrefix, deserialized.ObsScenePrefix);
    Assert.Equal(DbAppConfig.Default.DiscordClientId, deserialized.DiscordClientId);
    Assert.Equal(DbAppConfig.Default.DiscordBotToken, deserialized.DiscordBotToken);
    Assert.Equal(DbAppConfig.Default.ChatterboxBaseUrl, deserialized.ChatterboxBaseUrl);
    Assert.Equal(DbAppConfig.Default.MusicPollIntervalMs, deserialized.MusicPollIntervalMs);
    Assert.Equal(DbAppConfig.Default.MusicPlayerctlPlayer, deserialized.MusicPlayerctlPlayer);
    Assert.Equal(DbAppConfig.Default.SoundVolume, deserialized.SoundVolume);
  }
}
