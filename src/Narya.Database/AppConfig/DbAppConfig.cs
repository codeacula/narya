using JasperFx.Events;

using Narya.Database.AppConfig.Events;

using DomainConfig = Narya.Domain.AppConfig.AppConfig;

namespace Narya.Database.AppConfig;

/// <summary>
/// Marten self-aggregating inline snapshot for the singleton <c>AppConfig</c> root
/// stream. Marten discovers <see cref="Create"/> and <see cref="Apply"/> by convention
/// (see <c>NaryaMartenConfig.Configure</c>'s <c>Projections.Snapshot&lt;DbAppConfig&gt;</c>
/// registration) and must be public — a private nested type fails Marten's storage
/// codegen at runtime (the same lesson Task 4's <c>MartenSmokeTests.Doc</c> documents).
/// </summary>
public sealed record DbAppConfig
{
  /// <summary>
  /// The one place the legacy-parity default literals are written down. Every other
  /// default — <see cref="Narya.Domain.AppConfig.AppConfig"/>'s own property
  /// initializers, and this projection's starting state in <see cref="Create"/> — is
  /// derived from this value instead of repeating the literals.
  /// </summary>
  private static readonly DomainConfig DomainDefaults = new();

  public static readonly DbAppConfig Default = new()
  {
    TwitchChannel = DomainDefaults.TwitchChannel,
    TwitchClientId = DomainDefaults.TwitchClientId,
    TwitchClientSecret = DomainDefaults.TwitchClientSecret,
    ObsUrl = DomainDefaults.ObsUrl,
    ObsPassword = DomainDefaults.ObsPassword,
    ObsScenePrefix = DomainDefaults.ObsScenePrefix,
    DiscordClientId = DomainDefaults.DiscordClientId,
    DiscordBotToken = DomainDefaults.DiscordBotToken,
    ChatterboxBaseUrl = DomainDefaults.ChatterboxBaseUrl,
    MusicPollIntervalMs = DomainDefaults.MusicPollIntervalMs,
    MusicPlayerctlPlayer = DomainDefaults.MusicPlayerctlPlayer,
    SoundVolume = DomainDefaults.SoundVolume,
  };

  public Guid Id { get; init; }

  /// <summary>
  /// Every initializer from here down is the DOMAIN default, not a bare literal —
  /// deliberately, even though <see cref="Default"/> already sets each of these
  /// explicitly via its object initializer, which normally makes a property initializer
  /// dead for anyone constructing through <see cref="Default"/>. These initializers are
  /// what a Marten snapshot predating a LATER-added field deserializes to:
  /// <see cref="Apply"/>/<see cref="Create"/> only ever set fields this record already
  /// knows about, so a field added in a future phase has no historical event data to
  /// derive from, and System.Text.Json (Marten's snapshot deserializer) falls back to the
  /// property's own initializer for any property missing from an old JSON document. A
  /// bare <c>= 0</c>/<c>= ""</c> there would silently reintroduce the CLR default (e.g. a
  /// 0ms poll interval — a hot loop) for every existing install instead of the domain
  /// default.
  /// </summary>
  public string TwitchChannel { get; init; } = DomainDefaults.TwitchChannel;
  public string TwitchClientId { get; init; } = DomainDefaults.TwitchClientId;
  public string TwitchClientSecret { get; init; } = DomainDefaults.TwitchClientSecret;
  public string ObsUrl { get; init; } = DomainDefaults.ObsUrl;
  public string ObsPassword { get; init; } = DomainDefaults.ObsPassword;
  public string ObsScenePrefix { get; init; } = DomainDefaults.ObsScenePrefix;
  public string DiscordClientId { get; init; } = DomainDefaults.DiscordClientId;
  public string DiscordBotToken { get; init; } = DomainDefaults.DiscordBotToken;
  public string ChatterboxBaseUrl { get; init; } = DomainDefaults.ChatterboxBaseUrl;
  public int MusicPollIntervalMs { get; init; } = DomainDefaults.MusicPollIntervalMs;
  public string MusicPlayerctlPlayer { get; init; } = DomainDefaults.MusicPlayerctlPlayer;
  public double SoundVolume { get; init; } = DomainDefaults.SoundVolume;
  public DateTimeOffset? UpdatedAt { get; init; }

  public static DbAppConfig Create(IEvent<AppConfigUpdatedEvent> ev) => Apply(ev, Default);

  public static DbAppConfig Apply(IEvent<AppConfigUpdatedEvent> ev, DbAppConfig current) => current with
  {
    TwitchChannel = ev.Data.TwitchChannel ?? current.TwitchChannel,
    TwitchClientId = ev.Data.TwitchClientId ?? current.TwitchClientId,
    TwitchClientSecret = ev.Data.TwitchClientSecret ?? current.TwitchClientSecret,
    ObsUrl = ev.Data.ObsUrl ?? current.ObsUrl,
    ObsPassword = ev.Data.ObsPassword ?? current.ObsPassword,
    ObsScenePrefix = ev.Data.ObsScenePrefix ?? current.ObsScenePrefix,
    DiscordClientId = ev.Data.DiscordClientId ?? current.DiscordClientId,
    DiscordBotToken = ev.Data.DiscordBotToken ?? current.DiscordBotToken,
    ChatterboxBaseUrl = ev.Data.ChatterboxBaseUrl ?? current.ChatterboxBaseUrl,
    MusicPollIntervalMs = ev.Data.MusicPollIntervalMs ?? current.MusicPollIntervalMs,
    MusicPlayerctlPlayer = ev.Data.MusicPlayerctlPlayer ?? current.MusicPlayerctlPlayer,
    SoundVolume = ev.Data.SoundVolume ?? current.SoundVolume,
    UpdatedAt = ev.Data.OccurredAt,
  };

  public static explicit operator DomainConfig(DbAppConfig db)
  {
    return new DomainConfig
    {
      TwitchChannel = db.TwitchChannel,
      TwitchClientId = db.TwitchClientId,
      TwitchClientSecret = db.TwitchClientSecret,
      ObsUrl = db.ObsUrl,
      ObsPassword = db.ObsPassword,
      ObsScenePrefix = db.ObsScenePrefix,
      DiscordClientId = db.DiscordClientId,
      DiscordBotToken = db.DiscordBotToken,
      ChatterboxBaseUrl = db.ChatterboxBaseUrl,
      MusicPollIntervalMs = db.MusicPollIntervalMs,
      MusicPlayerctlPlayer = db.MusicPlayerctlPlayer,
      SoundVolume = db.SoundVolume,
      UpdatedAt = db.UpdatedAt,
    };
  }
}
