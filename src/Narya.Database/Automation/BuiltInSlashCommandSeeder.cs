using Marten;

using Narya.Core.Actions;
using Narya.Core.Automation;
using Narya.Database.Actions;
using Narya.Database.Common;

namespace Narya.Database.Automation;

/// <summary>
/// Seeds the four dashboard slash commands the client used to hand-parse — a port of legacy's
/// <c>seedBuiltInSlashCommands</c> (<c>legacy/src/server/automationTriggers.ts:344-432</c>). Runs
/// once, ever, per database (<see cref="SeedLedgerId"/> guards it via
/// <see cref="SeedLedgerDocument"/> — the Marten equivalent of legacy's <c>runOnce</c>), so an
/// operator's later edit or delete of a seeded row is never recreated on the next boot.
///
/// <para>
/// <b>Bypasses <see cref="IActionStore"/>/<see cref="IAutomationTriggerStore"/> entirely</b> and
/// writes <see cref="ActionDocument"/>/<see cref="AutomationTriggerDocument"/> straight into one
/// session, exactly like legacy's own <c>insertSeedAction</c>/<c>insertSeedStep</c> prepared
/// statements bypass <c>actions.ts</c>'s <c>normalizeActionUpsert</c>. Two reasons: (1) every field
/// here is a trusted, hand-authored literal, not user input, so there is nothing to validate; (2)
/// the whole seed — 4 Actions, 4 triggers, and the ledger row — must commit in ONE transaction
/// (matching legacy's <c>db.transaction(() => { migrate(); recordMigration.run(...); })()</c>), and
/// <c>IActionStore.CreateAsync</c>/<c>IAutomationTriggerStore.CreateAsync</c> each open and commit
/// their own session, which would turn one atomic seed into 9 independent ones.
/// </para>
///
/// <para>
/// Called from <c>Narya.Api.Program.cs</c> after the host is built, inside the same
/// <c>Narya:SkipInfrastructure</c> guard as <c>AddNaryaDatabase</c> — a <c>WebApplicationFactory</c>
/// test never runs it, the same way it never runs any other real-store registration in that guard.
/// </para>
/// </summary>
public static class BuiltInSlashCommandSeeder
{
  public const string SeedLedgerId = "seed-builtin-dashboard-slash-commands";

  private sealed record SeedCommand(string Name, string Description, string Command, IReadOnlyList<string> Aliases, ActionStep Step);

  /// <summary>
  /// <c>{arg1}</c> is the target, <c>{rest}</c> everything after it, <c>{rest2}</c> everything
  /// after the second argument. Cooldowns are zero: an operator timing out two spammers in a row
  /// must not be rate limited by their own tool — see <see cref="SeedAsync"/>.
  /// </summary>
  private static IReadOnlyList<SeedCommand> Seeds { get; } =
  [
    new(
      "Shoutout",
      "Shout out a viewer from the dashboard chat bar.",
      "/shoutout",
      ["/so"],
      new TwitchShoutoutActionStep { LoginTemplate = "{arg1}" }),
    new(
      "Whisper",
      "Whisper a viewer. Usage: /whisper <user> <message>",
      "/whisper",
      ["/w"],
      new TwitchWhisperActionStep { LoginTemplate = "{arg1}", Template = "{rest}" }),
    // The retired client parser guessed: if the second token was numeric it was the duration,
    // otherwise the whole remainder was the reason. Templates cannot express that conditional, so
    // the duration is now positional. A non-numeric or missing {arg2} still lands the timeout at
    // the executor's DEFAULT_TIMEOUT_SECONDS fallback (Phase 4 Task 3) rather than failing.
    new(
      "Timeout",
      "Time a viewer out. Usage: /timeout <user> <seconds> [reason]",
      "/timeout",
      [],
      new TwitchTimeoutActionStep { LoginTemplate = "{arg1}", SecondsTemplate = "{arg2}", ReasonTemplate = "{rest2}" }),
    new(
      "Ban",
      "Ban a viewer. Usage: /ban <user> [reason]",
      "/ban",
      [],
      new TwitchBanActionStep { LoginTemplate = "{arg1}", ReasonTemplate = "{rest}" }),
  ];

  public static async Task SeedAsync(IDocumentStore store, TimeProvider timeProvider, CancellationToken cancellationToken)
  {
    await using var session = store.LightweightSession();

    var alreadySeeded = await session.LoadAsync<SeedLedgerDocument>(SeedLedgerId, cancellationToken).ConfigureAwait(false);
    if (alreadySeeded is not null)
    {
      return;
    }

    var takenNames = (await session.Query<ActionDocument>().Select(a => a.Name).ToListAsync(cancellationToken).ConfigureAwait(false))
      .ToHashSet(StringComparer.OrdinalIgnoreCase);

    var now = timeProvider.GetUtcNow();
    foreach (var seed in Seeds)
    {
      var name = AvailableActionName(seed.Name, takenNames);
      _ = takenNames.Add(name); // reserve it so two seeds in the same run can't collide with each other

      var actionId = Guid.NewGuid();
      session.Insert(new ActionDocument
      {
        Id = actionId,
        Name = name,
        Description = seed.Description,
        Enabled = true,
        QuickDisable = false,
        Steps = [seed.Step with { Id = Guid.NewGuid(), Position = 0 }],
        CreatedAt = now,
        UpdatedAt = now,
      });

      session.Insert(new AutomationTriggerDocument
      {
        Id = Guid.NewGuid(),
        Kind = AutomationTriggerKind.DashboardSlash,
        ActionId = actionId,
        ModuleId = null,
        Enabled = true,
        Config = new DashboardSlashTriggerConfig { Command = seed.Command, Aliases = seed.Aliases },
        GlobalCooldownMs = 0,
        UserCooldownMs = 0,
        CreatedAt = now,
        UpdatedAt = now,
      });
    }

    session.Insert(new SeedLedgerDocument { Id = SeedLedgerId, AppliedAt = now });

    await session.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
  }

  /// <summary><c>actions.Name</c> is unique case-insensitive; an operator may already own e.g. "Shoutout". Never fail the boot over it.</summary>
  private static string AvailableActionName(string baseName, HashSet<string> taken)
  {
    if (!taken.Contains(baseName))
    {
      return baseName;
    }

    for (var suffix = 2; suffix < 50; suffix++)
    {
      var candidate = $"{baseName} ({suffix})";
      if (!taken.Contains(candidate))
      {
        return candidate;
      }
    }

    return $"{baseName} {Guid.NewGuid().ToString()[..8]}";
  }
}
