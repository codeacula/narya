using Marten;

using Narya.Core.Actions;
using Narya.Core.Automation;
using Narya.Database.Actions;
using Narya.Database.Automation;
using Narya.Database.Tests.Fixtures;

namespace Narya.Database.Tests.Automation;

[Collection("postgres")]
public sealed class AutomationTriggerStoreTests(PostgresFixture fixture)
{
  private async Task<IDocumentStore> BuildCleanDocumentStoreAsync()
  {
    var documentStore = fixture.CreateStore(NaryaMartenConfig.Configure);
    await documentStore.Storage.ApplyAllConfiguredChangesToDatabaseAsync();
    await documentStore.Advanced.Clean.DeleteAllEventDataAsync(CancellationToken.None);
    await documentStore.Advanced.Clean.DeleteAllDocumentsAsync(CancellationToken.None);
    return documentStore;
  }

  private static async Task<Guid> CreateActionAsync(IDocumentStore documentStore, string name = "Hype Train")
  {
    var actionStore = new ActionStore(documentStore, TimeProvider.System);
    var created = await actionStore.CreateAsync(
      new ActionUpsert { Name = name, Steps = [new ObsTransitionActionStep()] },
      CancellationToken.None);
    Assert.True(created.IsSuccess);
    return created.Value.Id;
  }

  private static AutomationTriggerUpsert Upsert(Guid actionId, TriggerConfig config, Guid? moduleId = null) => new()
  {
    ActionId = actionId,
    ModuleId = moduleId,
    Config = config,
  };

  // ---------------------------------------------------------------------------------------
  // Create / GetById round-trip, per kind — proves TriggerConfigJsonConverter survives Marten
  // ---------------------------------------------------------------------------------------

  [Fact]
  public async Task RewardConfigRoundTripsThroughMarten()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var actionId = await CreateActionAsync(documentStore);
    var store = new AutomationTriggerStore(documentStore, new ActionStore(documentStore, TimeProvider.System), TimeProvider.System);

    var created = await store.CreateAsync(Upsert(actionId, new RewardTriggerConfig { RewardId = "reward-42" }), CancellationToken.None);
    Assert.True(created.IsSuccess);
    Assert.Equal(AutomationTriggerKind.Reward, created.Value.Kind);

    var fetched = await store.GetByIdAsync(created.Value.Id, CancellationToken.None);
    Assert.NotNull(fetched);
    var config = Assert.IsType<RewardTriggerConfig>(fetched.Config);
    Assert.Equal("reward-42", config.RewardId);
  }

  [Fact]
  public async Task TwitchEventConfigRoundTripsThroughMarten()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var actionId = await CreateActionAsync(documentStore);
    var store = new AutomationTriggerStore(documentStore, new ActionStore(documentStore, TimeProvider.System), TimeProvider.System);

    var created = await store.CreateAsync(Upsert(actionId, new TwitchEventTriggerConfig { EventKind = TwitchAlertEventKind.Raid }), CancellationToken.None);
    Assert.True(created.IsSuccess);

    var fetched = await store.GetByIdAsync(created.Value.Id, CancellationToken.None);
    Assert.NotNull(fetched);
    Assert.Equal(AutomationTriggerKind.TwitchEvent, fetched.Kind);
    var config = Assert.IsType<TwitchEventTriggerConfig>(fetched.Config);
    Assert.Equal(TwitchAlertEventKind.Raid, config.EventKind);
  }

  [Fact]
  public async Task ChatPhraseConfigRoundTripsThroughMartenWithRoles()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var actionId = await CreateActionAsync(documentStore);
    var store = new AutomationTriggerStore(documentStore, new ActionStore(documentStore, TimeProvider.System), TimeProvider.System);

    var created = await store.CreateAsync(
      Upsert(actionId, new ChatPhraseTriggerConfig { Phrase = "hype", Match = ChatPhraseMatch.StartsWith, Roles = [TriggerRole.Mod, TriggerRole.Vip] }),
      CancellationToken.None);
    Assert.True(created.IsSuccess);

    var fetched = await store.GetByIdAsync(created.Value.Id, CancellationToken.None);
    Assert.NotNull(fetched);
    Assert.Equal(AutomationTriggerKind.ChatPhrase, fetched.Kind);
    var config = Assert.IsType<ChatPhraseTriggerConfig>(fetched.Config);
    Assert.Equal("hype", config.Phrase);
    Assert.Equal(ChatPhraseMatch.StartsWith, config.Match);
    Assert.Equal([TriggerRole.Mod, TriggerRole.Vip], config.Roles);
  }

  [Fact]
  public async Task ViewerCommandConfigRoundTripsThroughMartenWithAliasesAndRoles()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var actionId = await CreateActionAsync(documentStore);
    var store = new AutomationTriggerStore(documentStore, new ActionStore(documentStore, TimeProvider.System), TimeProvider.System);

    var created = await store.CreateAsync(
      Upsert(actionId, new ViewerCommandTriggerConfig { Command = "!quack", Aliases = ["!duck"], Roles = [TriggerRole.Sub] }),
      CancellationToken.None);
    Assert.True(created.IsSuccess);

    var fetched = await store.GetByIdAsync(created.Value.Id, CancellationToken.None);
    Assert.NotNull(fetched);
    Assert.Equal(AutomationTriggerKind.ViewerCommand, fetched.Kind);
    var config = Assert.IsType<ViewerCommandTriggerConfig>(fetched.Config);
    Assert.Equal("!quack", config.Command);
    Assert.Equal(["!duck"], config.Aliases);
    Assert.Equal([TriggerRole.Sub], config.Roles);
  }

  [Fact]
  public async Task DashboardSlashConfigRoundTripsThroughMartenWithAliases()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var actionId = await CreateActionAsync(documentStore);
    var store = new AutomationTriggerStore(documentStore, new ActionStore(documentStore, TimeProvider.System), TimeProvider.System);

    var created = await store.CreateAsync(
      Upsert(actionId, new DashboardSlashTriggerConfig { Command = "/shoutout", Aliases = ["/so"] }),
      CancellationToken.None);
    Assert.True(created.IsSuccess);

    var fetched = await store.GetByIdAsync(created.Value.Id, CancellationToken.None);
    Assert.NotNull(fetched);
    Assert.Equal(AutomationTriggerKind.DashboardSlash, fetched.Kind);
    var config = Assert.IsType<DashboardSlashTriggerConfig>(fetched.Config);
    Assert.Equal("/shoutout", config.Command);
    Assert.Equal(["/so"], config.Aliases);
  }

  [Fact]
  public async Task ManualConfigRoundTripsThroughMarten()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var actionId = await CreateActionAsync(documentStore);
    var store = new AutomationTriggerStore(documentStore, new ActionStore(documentStore, TimeProvider.System), TimeProvider.System);

    var created = await store.CreateAsync(Upsert(actionId, new ManualTriggerConfig { Label = "Intermission" }), CancellationToken.None);
    Assert.True(created.IsSuccess);

    var fetched = await store.GetByIdAsync(created.Value.Id, CancellationToken.None);
    Assert.NotNull(fetched);
    Assert.Equal(AutomationTriggerKind.Manual, fetched.Kind);
    var config = Assert.IsType<ManualTriggerConfig>(fetched.Config);
    Assert.Equal("Intermission", config.Label);
  }

  [Fact]
  public async Task ModuleActivateConfigRoundTripsThroughMarten()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var actionId = await CreateActionAsync(documentStore);
    var store = new AutomationTriggerStore(documentStore, new ActionStore(documentStore, TimeProvider.System), TimeProvider.System);
    var moduleId = Guid.NewGuid(); // unvalidated until Phase 8 — see AutomationTrigger's doc comment

    var created = await store.CreateAsync(Upsert(actionId, new ModuleActivateTriggerConfig(), moduleId), CancellationToken.None);
    Assert.True(created.IsSuccess);

    var fetched = await store.GetByIdAsync(created.Value.Id, CancellationToken.None);
    Assert.NotNull(fetched);
    Assert.Equal(AutomationTriggerKind.ModuleActivate, fetched.Kind);
    _ = Assert.IsType<ModuleActivateTriggerConfig>(fetched.Config);
    Assert.Equal(moduleId, fetched.ModuleId);
  }

  [Fact]
  public async Task ModuleDeactivateConfigRoundTripsThroughMarten()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var actionId = await CreateActionAsync(documentStore);
    var store = new AutomationTriggerStore(documentStore, new ActionStore(documentStore, TimeProvider.System), TimeProvider.System);

    var created = await store.CreateAsync(Upsert(actionId, new ModuleDeactivateTriggerConfig()), CancellationToken.None);
    Assert.True(created.IsSuccess);

    var fetched = await store.GetByIdAsync(created.Value.Id, CancellationToken.None);
    Assert.NotNull(fetched);
    Assert.Equal(AutomationTriggerKind.ModuleDeactivate, fetched.Kind);
    _ = Assert.IsType<ModuleDeactivateTriggerConfig>(fetched.Config);
  }

  // ---------------------------------------------------------------------------------------
  // ActionId existence
  // ---------------------------------------------------------------------------------------

  [Fact]
  public async Task CreateWithAnUnknownActionIdFails()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new AutomationTriggerStore(documentStore, new ActionStore(documentStore, TimeProvider.System), TimeProvider.System);

    var result = await store.CreateAsync(Upsert(Guid.NewGuid(), new ManualTriggerConfig { Label = "x" }), CancellationToken.None);

    Assert.True(result.IsFailed);
    Assert.Contains(result.Errors, e => e.Message == "Action not found.");
    var all = await store.GetAllAsync(CancellationToken.None);
    Assert.Empty(all);
  }

  [Fact]
  public async Task UpdateWithAnUnknownActionIdFailsAndLeavesTheStoredRowUntouched()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var actionId = await CreateActionAsync(documentStore);
    var store = new AutomationTriggerStore(documentStore, new ActionStore(documentStore, TimeProvider.System), TimeProvider.System);
    var created = await store.CreateAsync(Upsert(actionId, new ManualTriggerConfig { Label = "Original" }), CancellationToken.None);

    var result = await store.UpdateAsync(created.Value.Id, Upsert(Guid.NewGuid(), new ManualTriggerConfig { Label = "New" }), CancellationToken.None);

    Assert.NotNull(result);
    Assert.True(result.IsFailed);
    var stillThere = await store.GetByIdAsync(created.Value.Id, CancellationToken.None);
    var config = Assert.IsType<ManualTriggerConfig>(stillThere!.Config);
    Assert.Equal("Original", config.Label);
  }

  // ---------------------------------------------------------------------------------------
  // CRUD basics
  // ---------------------------------------------------------------------------------------

  [Fact]
  public async Task CreateValidationFailureInsertsNothing()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var actionId = await CreateActionAsync(documentStore);
    var store = new AutomationTriggerStore(documentStore, new ActionStore(documentStore, TimeProvider.System), TimeProvider.System);

    var result = await store.CreateAsync(Upsert(actionId, new ManualTriggerConfig { Label = "" }), CancellationToken.None);

    Assert.True(result.IsFailed);
    Assert.Empty(await store.GetAllAsync(CancellationToken.None));
  }

  [Fact]
  public async Task GetByIdReturnsNullForAnUnknownId()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new AutomationTriggerStore(documentStore, new ActionStore(documentStore, TimeProvider.System), TimeProvider.System);

    Assert.Null(await store.GetByIdAsync(Guid.NewGuid(), CancellationToken.None));
  }

  [Fact]
  public async Task UpdateOnAnUnknownIdReturnsNull()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var actionId = await CreateActionAsync(documentStore);
    var store = new AutomationTriggerStore(documentStore, new ActionStore(documentStore, TimeProvider.System), TimeProvider.System);

    var result = await store.UpdateAsync(Guid.NewGuid(), Upsert(actionId, new ManualTriggerConfig { Label = "x" }), CancellationToken.None);

    Assert.Null(result);
  }

  [Fact]
  public async Task UpdateReplacesKindAndConfigWhenTheNewConfigIsADifferentKind()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var actionId = await CreateActionAsync(documentStore);
    var store = new AutomationTriggerStore(documentStore, new ActionStore(documentStore, TimeProvider.System), TimeProvider.System);
    var created = await store.CreateAsync(Upsert(actionId, new ManualTriggerConfig { Label = "Intermission" }), CancellationToken.None);

    var updated = await store.UpdateAsync(
      created.Value.Id,
      Upsert(actionId, new ChatPhraseTriggerConfig { Phrase = "raid", Match = ChatPhraseMatch.Exact }),
      CancellationToken.None);

    Assert.NotNull(updated);
    Assert.True(updated.IsSuccess);
    Assert.Equal(AutomationTriggerKind.ChatPhrase, updated.Value.Kind);
    _ = Assert.IsType<ChatPhraseTriggerConfig>(updated.Value.Config);
  }

  [Fact]
  public async Task DeleteOnAnUnknownIdReturnsFalse()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new AutomationTriggerStore(documentStore, new ActionStore(documentStore, TimeProvider.System), TimeProvider.System);

    Assert.False(await store.DeleteAsync(Guid.NewGuid(), CancellationToken.None));
  }

  [Fact]
  public async Task DeleteRemovesTheTrigger()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var actionId = await CreateActionAsync(documentStore);
    var store = new AutomationTriggerStore(documentStore, new ActionStore(documentStore, TimeProvider.System), TimeProvider.System);
    var created = await store.CreateAsync(Upsert(actionId, new ManualTriggerConfig { Label = "x" }), CancellationToken.None);

    Assert.True(await store.DeleteAsync(created.Value.Id, CancellationToken.None));
    Assert.Null(await store.GetByIdAsync(created.Value.Id, CancellationToken.None));
  }

  [Fact]
  public async Task GetAllIsOrderedByCreatedAt()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var actionId = await CreateActionAsync(documentStore);
    var store = new AutomationTriggerStore(documentStore, new ActionStore(documentStore, TimeProvider.System), TimeProvider.System);
    var first = await store.CreateAsync(Upsert(actionId, new ManualTriggerConfig { Label = "first" }), CancellationToken.None);
    var second = await store.CreateAsync(Upsert(actionId, new ManualTriggerConfig { Label = "second" }), CancellationToken.None);

    var all = await store.GetAllAsync(CancellationToken.None);

    Assert.Equal([first.Value.Id, second.Value.Id], all.Select(t => t.Id));
  }

  // ---------------------------------------------------------------------------------------
  // GetEnabledByKindAsync — the (Phase 4 Task 6) dispatcher's read path
  // ---------------------------------------------------------------------------------------

  [Fact]
  public async Task GetEnabledByKindSkipsDisabledTriggersAndOtherKinds()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var actionId = await CreateActionAsync(documentStore);
    var store = new AutomationTriggerStore(documentStore, new ActionStore(documentStore, TimeProvider.System), TimeProvider.System);

    var enabledChatPhrase = await store.CreateAsync(
      Upsert(actionId, new ChatPhraseTriggerConfig { Phrase = "hype", Match = ChatPhraseMatch.Contains }),
      CancellationToken.None);
    var disabledChatPhrase = await store.CreateAsync(
      Upsert(actionId, new ChatPhraseTriggerConfig { Phrase = "raid", Match = ChatPhraseMatch.Contains }) with { Enabled = false },
      CancellationToken.None);
    _ = await store.CreateAsync(Upsert(actionId, new ManualTriggerConfig { Label = "Intermission" }), CancellationToken.None);

    var enabled = await store.GetEnabledByKindAsync(AutomationTriggerKind.ChatPhrase, CancellationToken.None);

    var single = Assert.Single(enabled);
    Assert.Equal(enabledChatPhrase.Value.Id, single.Id);
    Assert.NotEqual(disabledChatPhrase.Value.Id, single.Id);
  }
}
