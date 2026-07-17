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
  public string TwitchChannel { get; init; } = "";
  public string TwitchClientId { get; init; } = "";
  public string TwitchClientSecret { get; init; } = "";
  public string ObsUrl { get; init; } = "";
  public string ObsPassword { get; init; } = "";
  public string ObsScenePrefix { get; init; } = "";
  public string DiscordClientId { get; init; } = "";
  public string DiscordBotToken { get; init; } = "";
  public string ChatterboxBaseUrl { get; init; } = "";
  public int MusicPollIntervalMs { get; init; }
  public string MusicPlayerctlPlayer { get; init; } = "";
  public double SoundVolume { get; init; }
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
