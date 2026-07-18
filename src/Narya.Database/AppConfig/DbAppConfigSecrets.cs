using DomainConfig = Narya.Domain.AppConfig.AppConfig;

namespace Narya.Database.AppConfig;

/// <summary>
/// The secret half of the app configuration: a PLAIN Marten document (not a snapshot
/// projection, not an event stream) written with <c>session.Store</c> overwrite semantics,
/// keyed by the same <see cref="AppConfigStore.RootId"/> singleton Guid as
/// <see cref="DbAppConfig"/> so the two halves always join.
///
/// <para>
/// This exists because an event stream is append-only: a secret written as event data is
/// readable forever, so rotating a leaked value could never erase the old one. Legacy
/// stored config as a single mutable row and UPDATEd it in place
/// (<c>legacy/src/server/db.ts</c>); overwrite-in-place here restores exactly that erasure
/// semantic. The non-secret fields stay event-sourced in <see cref="DbAppConfig"/>, so the
/// audit trail of when things changed survives. Crypto-shredding (encrypting fields inside
/// events) was explicitly not chosen — no crypto dependency, no key management.
/// </para>
/// </summary>
public sealed record DbAppConfigSecrets
{
  /// <summary>
  /// Same rule as <see cref="DbAppConfig"/>'s initializers: the DOMAIN default, not a bare
  /// <c>""</c> literal, because these initializers are what a stored document predating a
  /// later-added field deserializes to.
  /// </summary>
  private static readonly DomainConfig DomainDefaults = new();

  public static readonly DbAppConfigSecrets Default = new()
  {
    TwitchClientSecret = DomainDefaults.TwitchClientSecret,
    ObsPassword = DomainDefaults.ObsPassword,
    DiscordBotToken = DomainDefaults.DiscordBotToken,
  };

  public Guid Id { get; init; }

  public string TwitchClientSecret { get; init; } = DomainDefaults.TwitchClientSecret;
  public string ObsPassword { get; init; } = DomainDefaults.ObsPassword;
  public string DiscordBotToken { get; init; } = DomainDefaults.DiscordBotToken;
}
