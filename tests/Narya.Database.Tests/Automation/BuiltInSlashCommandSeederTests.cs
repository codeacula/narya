using Marten;

using Narya.Core.Actions;
using Narya.Core.Automation;
using Narya.Database.Actions;
using Narya.Database.Automation;
using Narya.Database.Common;
using Narya.Database.Tests.Fixtures;

namespace Narya.Database.Tests.Automation;

/// <summary>
/// A port of legacy's <c>describe('seedBuiltInSlashCommands', ...)</c> coverage
/// (<c>legacy/src/server/automationTriggers.test.ts:224-291</c>).
/// </summary>
[Collection("postgres")]
public sealed class BuiltInSlashCommandSeederTests(PostgresFixture fixture)
{
  private async Task<IDocumentStore> BuildCleanDocumentStoreAsync()
  {
    var documentStore = fixture.CreateStore(NaryaMartenConfig.Configure);
    await documentStore.Storage.ApplyAllConfiguredChangesToDatabaseAsync();
    await documentStore.Advanced.Clean.DeleteAllEventDataAsync(CancellationToken.None);
    await documentStore.Advanced.Clean.DeleteAllDocumentsAsync(CancellationToken.None);
    return documentStore;
  }

  [Fact]
  public async Task SeedsShoutoutWhisperTimeoutAndBanAsFourEditableTriggersAndActions()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();

    await BuiltInSlashCommandSeeder.SeedAsync(documentStore, TimeProvider.System, CancellationToken.None);

    var triggerStore = new AutomationTriggerStore(documentStore, new ActionStore(documentStore, TimeProvider.System), TimeProvider.System);
    var triggers = await triggerStore.GetEnabledByKindAsync(AutomationTriggerKind.DashboardSlash, CancellationToken.None);
    Assert.Equal(4, triggers.Count);

    var byCommand = triggers.ToDictionary(t => ((DashboardSlashTriggerConfig)t.Config).Command);
    Assert.Equal(["/ban", "/shoutout", "/timeout", "/whisper"], byCommand.Keys.OrderBy(k => k, StringComparer.Ordinal));

    var shoutoutConfig = (DashboardSlashTriggerConfig)byCommand["/shoutout"].Config;
    Assert.Equal(["/so"], shoutoutConfig.Aliases);

    var whisperConfig = (DashboardSlashTriggerConfig)byCommand["/whisper"].Config;
    Assert.Equal(["/w"], whisperConfig.Aliases);

    // Operator commands must not be rate limited: /timeout one viewer then another.
    Assert.All(triggers, t =>
    {
      Assert.Equal(0, t.GlobalCooldownMs);
      Assert.Equal(0, t.UserCooldownMs);
      Assert.Null(t.ModuleId);
    });

    var actionStore = new ActionStore(documentStore, TimeProvider.System);
    var actions = await actionStore.GetAllAsync(CancellationToken.None);
    Assert.Equal(4, actions.Count);
    Assert.Equal(["Ban", "Shoutout", "Timeout", "Whisper"], actions.Select(a => a.Name).OrderBy(n => n, StringComparer.Ordinal));
  }

  /// <summary>
  /// `/timeout bob 300 spam` must actually time bob out for 300s. A stored number would
  /// silently ignore the operator's duration and swallow it into the reason.
  /// </summary>
  [Fact]
  public async Task TheSeededTimeoutBindsItsDurationFromTheInvocationNotAStoredConstant()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();

    await BuiltInSlashCommandSeeder.SeedAsync(documentStore, TimeProvider.System, CancellationToken.None);

    var triggerStore = new AutomationTriggerStore(documentStore, new ActionStore(documentStore, TimeProvider.System), TimeProvider.System);
    var triggers = await triggerStore.GetEnabledByKindAsync(AutomationTriggerKind.DashboardSlash, CancellationToken.None);
    var timeoutTrigger = triggers.Single(t => ((DashboardSlashTriggerConfig)t.Config).Command == "/timeout");

    var actionStore = new ActionStore(documentStore, TimeProvider.System);
    var action = await actionStore.GetByIdAsync(timeoutTrigger.ActionId, CancellationToken.None);
    Assert.NotNull(action);
    var step = Assert.Single(action.Steps);
    var timeoutStep = Assert.IsType<TwitchTimeoutActionStep>(step);
    Assert.Equal("{arg1}", timeoutStep.LoginTemplate);
    Assert.Equal("{arg2}", timeoutStep.SecondsTemplate);
    Assert.Equal("{rest2}", timeoutStep.ReasonTemplate);
  }

  [Fact]
  public async Task IsIdempotentASecondCallSeedsNothingNew()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();

    await BuiltInSlashCommandSeeder.SeedAsync(documentStore, TimeProvider.System, CancellationToken.None);
    await BuiltInSlashCommandSeeder.SeedAsync(documentStore, TimeProvider.System, CancellationToken.None);

    var triggerStore = new AutomationTriggerStore(documentStore, new ActionStore(documentStore, TimeProvider.System), TimeProvider.System);
    var triggers = await triggerStore.GetEnabledByKindAsync(AutomationTriggerKind.DashboardSlash, CancellationToken.None);
    Assert.Equal(4, triggers.Count);

    var actionStore = new ActionStore(documentStore, TimeProvider.System);
    Assert.Equal(4, (await actionStore.GetAllAsync(CancellationToken.None)).Count);
  }

  [Fact]
  public async Task DoesNotCollideWithAnActionTheOperatorAlreadyNamedShoutout()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var actionStore = new ActionStore(documentStore, TimeProvider.System);
    var preExisting = await actionStore.CreateAsync(
      new ActionUpsert { Name = "Shoutout", Steps = [new ObsTransitionActionStep()] },
      CancellationToken.None);
    Assert.True(preExisting.IsSuccess);

    await BuiltInSlashCommandSeeder.SeedAsync(documentStore, TimeProvider.System, CancellationToken.None);

    var allActions = await actionStore.GetAllAsync(CancellationToken.None);
    Assert.Equal(5, allActions.Count); // the operator's own "Shoutout" + the 4 seeded (one renamed)
    Assert.Contains(allActions, a => a.Name == "Shoutout"); // the operator's original, untouched
    Assert.Contains(allActions, a => a.Name == "Shoutout (2)"); // the seeded one, renamed to avoid the collision

    var triggerStore = new AutomationTriggerStore(documentStore, actionStore, TimeProvider.System);
    var triggers = await triggerStore.GetEnabledByKindAsync(AutomationTriggerKind.DashboardSlash, CancellationToken.None);
    Assert.Equal(4, triggers.Count);
  }

  [Fact]
  public async Task TheLedgerRowIsWrittenSoAFutureBootCanCheckWithoutRescanningActions()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();

    await BuiltInSlashCommandSeeder.SeedAsync(documentStore, TimeProvider.System, CancellationToken.None);

    await using var querySession = documentStore.QuerySession();
    var ledgerEntry = await querySession.LoadAsync<SeedLedgerDocument>(BuiltInSlashCommandSeeder.SeedLedgerId, CancellationToken.None);
    Assert.NotNull(ledgerEntry);
  }
}
