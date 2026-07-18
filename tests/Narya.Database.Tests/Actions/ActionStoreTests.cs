using Marten;

using Narya.Core.Actions;
using Narya.Database.Actions;
using Narya.Database.Tests.Fixtures;

namespace Narya.Database.Tests.Actions;

[Collection("postgres")]
public sealed class ActionStoreTests(PostgresFixture fixture)
{
  private async Task<IDocumentStore> BuildCleanDocumentStoreAsync()
  {
    var documentStore = fixture.CreateStore(NaryaMartenConfig.Configure);
    await documentStore.Storage.ApplyAllConfiguredChangesToDatabaseAsync();
    await documentStore.Advanced.Clean.DeleteAllEventDataAsync(CancellationToken.None);
    await documentStore.Advanced.Clean.DeleteAllDocumentsAsync(CancellationToken.None);
    return documentStore;
  }

  private static ActionUpsert BuildUpsert(string name = "Hype Train", params ActionStep[] steps) => new()
  {
    Name = name,
    Description = "Plays a clip and shouts.",
    Steps = steps.Length == 0 ? [new ObsTransitionActionStep()] : steps,
  };

  // ---------------------------------------------------------------------------------------
  // Create / GetAll / GetById round-trip, with embedded typed steps
  // ---------------------------------------------------------------------------------------

  [Fact]
  public async Task CreateInsertsAndGetByIdReturnsItWithStepsInPositionOrder()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new ActionStore(documentStore, TimeProvider.System);
    var assetId = Guid.NewGuid();

    var created = await store.CreateAsync(
      BuildUpsert(
        steps:
        [
          new ShowTextActionStep { Template = "Hype!", Style = TextStyle.Banner, DurationMs = 3_000 },
          new PlayMediaActionStep { AssetIds = [assetId], Selection = MediaSelection.First },
          new TwitchShoutoutActionStep { LoginTemplate = "{arg1}" },
        ]),
      CancellationToken.None);

    Assert.True(created.IsSuccess);
    Assert.NotEqual(Guid.Empty, created.Value.Id);
    Assert.Equal("Hype Train", created.Value.Name);
    Assert.True(created.Value.Enabled);
    Assert.Equal(3, created.Value.Steps.Count);

    var fetched = await store.GetByIdAsync(created.Value.Id, CancellationToken.None);
    Assert.NotNull(fetched);
    Assert.Equal(3, fetched.Steps.Count);
    Assert.Equal([0, 1, 2], fetched.Steps.Select(s => s.Position));
    var showText = Assert.IsType<ShowTextActionStep>(fetched.Steps[0]);
    Assert.Equal("Hype!", showText.Template);
    var playMedia = Assert.IsType<PlayMediaActionStep>(fetched.Steps[1]);
    Assert.Equal([assetId], playMedia.AssetIds);
    var shoutout = Assert.IsType<TwitchShoutoutActionStep>(fetched.Steps[2]);
    Assert.Equal("{arg1}", shoutout.LoginTemplate);

    // Every step gets a fresh id on save — see ActionStore.AssignStepIdentity's doc comment.
    Assert.All(fetched.Steps, s => Assert.NotEqual(Guid.Empty, s.Id));
  }

  /// <summary>
  /// Backfills the coverage the review flagged: the original round-trip test above only exercises
  /// 3 of the 11 <see cref="ActionStep"/> types and doesn't assert every field survives reload. The
  /// hand-written <see cref="ActionStepJsonConverter"/> is the load-bearing mechanism that makes any
  /// step type survive Marten storage at all (see its doc comment) — a converter bug that drops or
  /// mangles one field on one step type is a silent data-loss bug, so this saves an Action with ONE
  /// step of EVERY type, each carrying distinct, non-default values on every payload field and on
  /// the base fields (<c>Enabled</c>, <c>DelayMs</c>), reloads it through a real Postgres via
  /// <see cref="ActionStore.GetByIdAsync"/>, and asserts every field on every step individually.
  /// </summary>
  [Fact]
  public async Task AllElevenStepTypesRoundTripThroughMartenWithEveryFieldIntact()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new ActionStore(documentStore, TimeProvider.System);
    var assetIdOne = Guid.NewGuid();
    var assetIdTwo = Guid.NewGuid();

    var created = await store.CreateAsync(
      BuildUpsert(
        steps:
        [
          new ShowTextActionStep
          {
            Template = "Hype train arriving!",
            DurationMs = 4_200,
            Style = TextStyle.Centered,
            Tone = "gold",
            Enabled = false,
            DelayMs = 100,
          },
          new PlayMediaActionStep
          {
            AssetIds = [assetIdOne, assetIdTwo],
            Selection = MediaSelection.Random,
            Volume = 0.33,
            DelayMs = 200,
          },
          new TtsSpeakActionStep
          {
            Template = "Announce the raid out loud.",
            DelayMs = 300,
          },
          new SendChatActionStep
          {
            Template = "Thanks for the raid!",
            Sender = ChatSender.Bot,
            DelayMs = 400,
          },
          new LlmResponseActionStep
          {
            Template = "Reply to {input} in one sentence.",
            DelayMs = 500,
          },
          new ObsSceneActionStep
          {
            SceneName = "Scene - Just Chatting",
            DelayMs = 600,
          },
          new ObsTransitionActionStep
          {
            DelayMs = 700,
          },
          new TwitchShoutoutActionStep
          {
            LoginTemplate = "{arg1}",
            DelayMs = 800,
          },
          new TwitchWhisperActionStep
          {
            LoginTemplate = "{arg2}",
            Template = "Welcome to the stream!",
            DelayMs = 900,
          },
          new TwitchTimeoutActionStep
          {
            LoginTemplate = "{arg1}",
            SecondsTemplate = "{arg2}",
            ReasonTemplate = "spam cleanup",
            DelayMs = 1_000,
          },
          new TwitchBanActionStep
          {
            LoginTemplate = "{arg3}",
            ReasonTemplate = "TOS violation",
            DelayMs = 1_100,
          },
        ]),
      CancellationToken.None);

    Assert.True(created.IsSuccess);
    Assert.Equal(11, created.Value.Steps.Count);

    var fetched = await store.GetByIdAsync(created.Value.Id, CancellationToken.None);
    Assert.NotNull(fetched);
    Assert.Equal(11, fetched.Steps.Count);
    Assert.Equal(Enumerable.Range(0, 11), fetched.Steps.Select(s => s.Position));
    Assert.All(fetched.Steps, s => Assert.NotEqual(Guid.Empty, s.Id));

    var showText = Assert.IsType<ShowTextActionStep>(fetched.Steps[0]);
    Assert.Equal(0, showText.Position);
    Assert.False(showText.Enabled);
    Assert.Equal(100, showText.DelayMs);
    Assert.Equal("Hype train arriving!", showText.Template);
    Assert.Equal(4_200, showText.DurationMs);
    Assert.Equal(TextStyle.Centered, showText.Style);
    Assert.Equal("gold", showText.Tone);

    var playMedia = Assert.IsType<PlayMediaActionStep>(fetched.Steps[1]);
    Assert.Equal(1, playMedia.Position);
    Assert.True(playMedia.Enabled);
    Assert.Equal(200, playMedia.DelayMs);
    Assert.Equal([assetIdOne, assetIdTwo], playMedia.AssetIds);
    Assert.Equal(MediaSelection.Random, playMedia.Selection);
    Assert.Equal(0.33, playMedia.Volume);

    var ttsSpeak = Assert.IsType<TtsSpeakActionStep>(fetched.Steps[2]);
    Assert.Equal(2, ttsSpeak.Position);
    Assert.True(ttsSpeak.Enabled);
    Assert.Equal(300, ttsSpeak.DelayMs);
    Assert.Equal("Announce the raid out loud.", ttsSpeak.Template);

    var sendChat = Assert.IsType<SendChatActionStep>(fetched.Steps[3]);
    Assert.Equal(3, sendChat.Position);
    Assert.True(sendChat.Enabled);
    Assert.Equal(400, sendChat.DelayMs);
    Assert.Equal("Thanks for the raid!", sendChat.Template);
    Assert.Equal(ChatSender.Bot, sendChat.Sender);

    var llmResponse = Assert.IsType<LlmResponseActionStep>(fetched.Steps[4]);
    Assert.Equal(4, llmResponse.Position);
    Assert.True(llmResponse.Enabled);
    Assert.Equal(500, llmResponse.DelayMs);
    Assert.Equal("Reply to {input} in one sentence.", llmResponse.Template);

    var obsScene = Assert.IsType<ObsSceneActionStep>(fetched.Steps[5]);
    Assert.Equal(5, obsScene.Position);
    Assert.True(obsScene.Enabled);
    Assert.Equal(600, obsScene.DelayMs);
    Assert.Equal("Scene - Just Chatting", obsScene.SceneName);

    var obsTransition = Assert.IsType<ObsTransitionActionStep>(fetched.Steps[6]);
    Assert.Equal(6, obsTransition.Position);
    Assert.True(obsTransition.Enabled);
    Assert.Equal(700, obsTransition.DelayMs);

    var shoutout = Assert.IsType<TwitchShoutoutActionStep>(fetched.Steps[7]);
    Assert.Equal(7, shoutout.Position);
    Assert.True(shoutout.Enabled);
    Assert.Equal(800, shoutout.DelayMs);
    Assert.Equal("{arg1}", shoutout.LoginTemplate);

    var whisper = Assert.IsType<TwitchWhisperActionStep>(fetched.Steps[8]);
    Assert.Equal(8, whisper.Position);
    Assert.True(whisper.Enabled);
    Assert.Equal(900, whisper.DelayMs);
    Assert.Equal("{arg2}", whisper.LoginTemplate);
    Assert.Equal("Welcome to the stream!", whisper.Template);

    var timeout = Assert.IsType<TwitchTimeoutActionStep>(fetched.Steps[9]);
    Assert.Equal(9, timeout.Position);
    Assert.True(timeout.Enabled);
    Assert.Equal(1_000, timeout.DelayMs);
    Assert.Equal("{arg1}", timeout.LoginTemplate);
    Assert.Equal("{arg2}", timeout.SecondsTemplate);
    Assert.Equal("spam cleanup", timeout.ReasonTemplate);

    var ban = Assert.IsType<TwitchBanActionStep>(fetched.Steps[10]);
    Assert.Equal(10, ban.Position);
    Assert.True(ban.Enabled);
    Assert.Equal(1_100, ban.DelayMs);
    Assert.Equal("{arg3}", ban.LoginTemplate);
    Assert.Equal("TOS violation", ban.ReasonTemplate);
  }

  [Fact]
  public async Task CreateValidationFailureInsertsNothing()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new ActionStore(documentStore, TimeProvider.System);

    var result = await store.CreateAsync(new ActionUpsert { Name = "" }, CancellationToken.None);

    Assert.True(result.IsFailed);
    var all = await store.GetAllAsync(CancellationToken.None);
    Assert.Empty(all);
  }

  [Fact]
  public async Task GetByIdReturnsNullForAnUnknownId()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new ActionStore(documentStore, TimeProvider.System);

    var fetched = await store.GetByIdAsync(Guid.NewGuid(), CancellationToken.None);

    Assert.Null(fetched);
  }

  [Fact]
  public async Task GetAllIsOrderedByNameCaseInsensitive()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new ActionStore(documentStore, TimeProvider.System);
    _ = await store.CreateAsync(BuildUpsert("zebra action"), CancellationToken.None);
    _ = await store.CreateAsync(BuildUpsert("Apple Action"), CancellationToken.None);
    _ = await store.CreateAsync(BuildUpsert("Mango Action"), CancellationToken.None);

    var all = await store.GetAllAsync(CancellationToken.None);

    Assert.Equal(["Apple Action", "Mango Action", "zebra action"], all.Select(a => a.Name));
  }

  // ---------------------------------------------------------------------------------------
  // Update — full replace, delete-all-reinsert semantics on Steps
  // ---------------------------------------------------------------------------------------

  [Fact]
  public async Task UpdateOnAnUnknownIdReturnsNull()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new ActionStore(documentStore, TimeProvider.System);

    var result = await store.UpdateAsync(Guid.NewGuid(), BuildUpsert(), CancellationToken.None);

    Assert.Null(result);
  }

  [Fact]
  public async Task UpdateWithANewStepsListReplacesTheOldStepsEntirely()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new ActionStore(documentStore, TimeProvider.System);
    var created = await store.CreateAsync(
      BuildUpsert(steps:
      [
        new ShowTextActionStep { Template = "one", Style = TextStyle.Banner },
        new ShowTextActionStep { Template = "two", Style = TextStyle.Toast },
        new ShowTextActionStep { Template = "three", Style = TextStyle.Centered },
      ]),
      CancellationToken.None);
    Assert.True(created.IsSuccess);
    var originalStepIds = created.Value.Steps.Select(s => s.Id).ToHashSet();

    var updated = await store.UpdateAsync(
      created.Value.Id,
      BuildUpsert(steps: [new TtsSpeakActionStep { Template = "only one now" }]),
      CancellationToken.None);

    Assert.NotNull(updated);
    Assert.True(updated.IsSuccess);
    _ = Assert.Single(updated.Value.Steps);
    var remaining = Assert.IsType<TtsSpeakActionStep>(updated.Value.Steps[0]);
    Assert.Equal("only one now", remaining.Template);
    Assert.DoesNotContain(remaining.Id, originalStepIds); // old step ids are gone, not reused

    var refetched = await store.GetByIdAsync(created.Value.Id, CancellationToken.None);
    Assert.NotNull(refetched);
    _ = Assert.Single(refetched.Steps);
  }

  [Fact]
  public async Task UpdateValidationFailureLeavesTheStoredRowUntouched()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new ActionStore(documentStore, TimeProvider.System);
    var created = await store.CreateAsync(BuildUpsert(), CancellationToken.None);

    var result = await store.UpdateAsync(created.Value.Id, new ActionUpsert { Name = "" }, CancellationToken.None);

    Assert.NotNull(result);
    Assert.True(result.IsFailed);
    var stillThere = await store.GetByIdAsync(created.Value.Id, CancellationToken.None);
    Assert.Equal("Hype Train", stillThere!.Name);
  }

  [Fact]
  public async Task UpdateBumpsUpdatedAtButPreservesCreatedAt()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new ActionStore(documentStore, TimeProvider.System);
    var created = await store.CreateAsync(BuildUpsert(), CancellationToken.None);

    var updated = await store.UpdateAsync(created.Value.Id, BuildUpsert(name: "Hype Train Renamed"), CancellationToken.None);

    Assert.NotNull(updated);
    Assert.True(updated.IsSuccess);
    Assert.Equal("Hype Train Renamed", updated.Value.Name);
    Assert.Equal(created.Value.CreatedAt, updated.Value.CreatedAt);
    Assert.True(updated.Value.UpdatedAt >= created.Value.UpdatedAt);
  }

  // ---------------------------------------------------------------------------------------
  // Name uniqueness — case-insensitive, via the real Postgres unique index
  // ---------------------------------------------------------------------------------------

  [Fact]
  public async Task CreatingADuplicateNameCaseInsensitiveFails409Style()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new ActionStore(documentStore, TimeProvider.System);
    var first = await store.CreateAsync(BuildUpsert("Hype"), CancellationToken.None);
    Assert.True(first.IsSuccess);

    var second = await store.CreateAsync(BuildUpsert("hype"), CancellationToken.None);

    Assert.True(second.IsFailed);
    Assert.True(second.HasError<DuplicateActionNameError>());
    var all = await store.GetAllAsync(CancellationToken.None);
    _ = Assert.Single(all); // the failed insert did not leave a row behind
  }

  [Fact]
  public async Task UpdatingToACollidingNameCaseInsensitiveFails()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new ActionStore(documentStore, TimeProvider.System);
    _ = await store.CreateAsync(BuildUpsert("Hype"), CancellationToken.None);
    var second = await store.CreateAsync(BuildUpsert("Other"), CancellationToken.None);
    Assert.True(second.IsSuccess);

    var result = await store.UpdateAsync(second.Value.Id, BuildUpsert("HYPE"), CancellationToken.None);

    Assert.NotNull(result);
    Assert.True(result.IsFailed);
    Assert.True(result.HasError<DuplicateActionNameError>());
    var stillThere = await store.GetByIdAsync(second.Value.Id, CancellationToken.None);
    Assert.Equal("Other", stillThere!.Name); // untouched by the failed rename
  }

  [Fact]
  public async Task ReSavingAnActionWithItsOwnUnchangedNameDoesNotSelfConflict()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new ActionStore(documentStore, TimeProvider.System);
    var created = await store.CreateAsync(BuildUpsert("Hype"), CancellationToken.None);

    var updated = await store.UpdateAsync(created.Value.Id, BuildUpsert("Hype", new TtsSpeakActionStep { Template = "hi" }), CancellationToken.None);

    Assert.NotNull(updated);
    Assert.True(updated.IsSuccess);
  }

  // ---------------------------------------------------------------------------------------
  // Delete
  // ---------------------------------------------------------------------------------------

  [Fact]
  public async Task DeleteOnAnUnknownIdReturnsFalse()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new ActionStore(documentStore, TimeProvider.System);

    var deleted = await store.DeleteAsync(Guid.NewGuid(), CancellationToken.None);

    Assert.False(deleted);
  }

  [Fact]
  public async Task DeleteRemovesTheActionAndItsEmbeddedSteps()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new ActionStore(documentStore, TimeProvider.System);
    var created = await store.CreateAsync(BuildUpsert(), CancellationToken.None);

    var deleted = await store.DeleteAsync(created.Value.Id, CancellationToken.None);

    Assert.True(deleted);
    var fetched = await store.GetByIdAsync(created.Value.Id, CancellationToken.None);
    Assert.Null(fetched);
  }
}
