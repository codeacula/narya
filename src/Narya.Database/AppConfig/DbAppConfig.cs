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
    ObsUrl = DomainDefaults.ObsUrl,
    ObsScenePrefix = DomainDefaults.ObsScenePrefix,
    DiscordClientId = DomainDefaults.DiscordClientId,
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
  public string ObsUrl { get; init; } = DomainDefaults.ObsUrl;
  public string ObsScenePrefix { get; init; } = DomainDefaults.ObsScenePrefix;
  public string DiscordClientId { get; init; } = DomainDefaults.DiscordClientId;
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
    ObsUrl = ev.Data.ObsUrl ?? current.ObsUrl,
    ObsScenePrefix = ev.Data.ObsScenePrefix ?? current.ObsScenePrefix,
    DiscordClientId = ev.Data.DiscordClientId ?? current.DiscordClientId,
    ChatterboxBaseUrl = ev.Data.ChatterboxBaseUrl ?? current.ChatterboxBaseUrl,
    MusicPollIntervalMs = ev.Data.MusicPollIntervalMs ?? current.MusicPollIntervalMs,
    MusicPlayerctlPlayer = ev.Data.MusicPlayerctlPlayer ?? current.MusicPlayerctlPlayer,
    SoundVolume = ev.Data.SoundVolume ?? current.SoundVolume,
    UpdatedAt = ev.Data.OccurredAt,
  };

  /// <summary>
  /// Composes the event-sourced non-secret half (this projection) with the
  /// overwrite-in-place secret half into the single domain record callers see. A null
  /// <paramref name="secrets"/> — no secret has ever been written, or every secret was
  /// cleared — reads back as the domain defaults (empty strings), never as a throw.
  /// Replaces the former <c>explicit operator</c>, which could not express the second
  /// input.
  /// </summary>
  public DomainConfig ToDomain(DbAppConfigSecrets? secrets)
  {
    var db = this;
    var s = secrets ?? DbAppConfigSecrets.Default;

    return new DomainConfig
    {
      TwitchChannel = db.TwitchChannel,
      TwitchClientId = db.TwitchClientId,
      TwitchClientSecret = s.TwitchClientSecret,
      ObsUrl = db.ObsUrl,
      ObsPassword = s.ObsPassword,
      ObsScenePrefix = db.ObsScenePrefix,
      DiscordClientId = db.DiscordClientId,
      DiscordBotToken = s.DiscordBotToken,
      ChatterboxBaseUrl = db.ChatterboxBaseUrl,
      MusicPollIntervalMs = db.MusicPollIntervalMs,
      MusicPlayerctlPlayer = db.MusicPlayerctlPlayer,
      SoundVolume = db.SoundVolume,
      UpdatedAt = db.UpdatedAt,
    };
  }
}
