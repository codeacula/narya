using Marten;

using Narya.Core.Chat;
using Narya.Database.Chat;
using Narya.Database.Tests.Fixtures;
using Narya.Database.Viewers;

namespace Narya.Database.Tests.Viewers;

[Collection("postgres")]
public sealed class ViewerStoreTests(PostgresFixture fixture)
{
  private async Task<IDocumentStore> BuildCleanDocumentStoreAsync()
  {
    var documentStore = fixture.CreateStore(NaryaMartenConfig.Configure);
    await documentStore.Storage.ApplyAllConfiguredChangesToDatabaseAsync();
    await documentStore.Advanced.Clean.DeleteAllEventDataAsync(CancellationToken.None);
    await documentStore.Advanced.Clean.DeleteAllDocumentsAsync(CancellationToken.None);
    return documentStore;
  }

  private static ChatMessage BuildMessage(
    string id,
    string username,
    DateTimeOffset receivedAt,
    string? displayName = null,
    string? color = null,
    IReadOnlyDictionary<string, string>? badges = null,
    string message = "hello chat") =>
    new(
      Id: id,
      Channel: "codeacula",
      Username: username,
      DisplayName: displayName ?? username,
      Color: color,
      Message: message,
      ReceivedAt: receivedAt,
      Badges: badges,
      ChatterUserId: $"{username}-id");

  // --- UpsertProfileAsync -----------------------------------------------------------------

  [Fact]
  public async Task UpsertProfileTrimsRealNameAndNote()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new ViewerStore(documentStore);

    var result = await store.UpsertProfileAsync(
      "Viewer", "  Real Name  ", [], "  a note  ", DateTimeOffset.UtcNow, CancellationToken.None);

    Assert.Equal("Real Name", result.RealName);
    Assert.Equal("a note", result.Note);
  }

  [Fact]
  public async Task UpsertProfileDedupesTagsCaseInsensitivelyKeepingFirstCasing()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new ViewerStore(documentStore);

    var result = await store.UpsertProfileAsync(
      "viewer", null, ["Fan", "fan", "FAN"], null, DateTimeOffset.UtcNow, CancellationToken.None);

    Assert.Equal(["Fan"], result.Tags);
  }

  [Fact]
  public async Task UpsertProfilePreservesCreatedAtOnUpdateAndChangesUpdatedAt()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new ViewerStore(documentStore);
    var insertedAt = DateTimeOffset.UtcNow;
    var updatedAt = insertedAt.AddMinutes(10);

    _ = await store.UpsertProfileAsync("viewer", "Original", [], "", insertedAt, CancellationToken.None);
    _ = await store.UpsertProfileAsync("viewer", "Updated", [], "", updatedAt, CancellationToken.None);

    var profile = await store.GetProfileAsync("viewer", CancellationToken.None);

    Assert.NotNull(profile);
    Assert.Equal("Updated", profile!.RealName);
    Assert.Equal(insertedAt, profile.CreatedAt); // untouched by the update
    Assert.Equal(updatedAt, profile.UpdatedAt);
  }

  [Fact]
  public async Task UpsertProfileIsCaseInsensitiveOnLogin()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new ViewerStore(documentStore);

    _ = await store.UpsertProfileAsync("Viewer", "First", [], "", DateTimeOffset.UtcNow, CancellationToken.None);
    _ = await store.UpsertProfileAsync("VIEWER", "Second", [], "", DateTimeOffset.UtcNow, CancellationToken.None);

    var profile = await store.GetProfileAsync("viewer", CancellationToken.None);

    Assert.Equal("Second", profile!.RealName); // the second call updated the SAME row
  }

  [Fact]
  public async Task GetProfileReturnsNullWhenNoneSaved()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new ViewerStore(documentStore);

    var profile = await store.GetProfileAsync("nobody", CancellationToken.None);

    Assert.Null(profile);
  }

  // --- GetRosterAsync ----------------------------------------------------------------------

  [Fact]
  public async Task GetRosterUsesTheChattersLastMessageFieldsWhenPresent()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var chatStore = new ChatStore(documentStore);
    var store = new ViewerStore(documentStore);
    var firstSeenAt = DateTimeOffset.UtcNow.AddDays(-1);
    var lastSeenAt = DateTimeOffset.UtcNow;

    await chatStore.UpsertChatterAsync(
      "viewer", firstSeenAt, "Viewer", "#123456",
      new Dictionary<string, string> { ["subscriber"] = "1" }, CancellationToken.None);
    await chatStore.UpsertChatterAsync(
      "viewer", lastSeenAt, "ViewerNewName", "#654321",
      new Dictionary<string, string> { ["subscriber"] = "1" }, CancellationToken.None);

    var roster = await store.GetRosterAsync(CancellationToken.None);

    var entry = Assert.Single(roster);
    Assert.Equal("viewer", entry.Login);
    Assert.Equal("ViewerNewName", entry.Display);
    Assert.Equal("#654321", entry.Color);
    Assert.Equal(["sub"], entry.Roles);
    Assert.Equal(2, entry.MessageCount);
    Assert.Equal(firstSeenAt, entry.FirstSeenAt);
    Assert.Equal(lastSeenAt, entry.LastSeenAt);
  }

  [Fact]
  public async Task GetRosterFallsBackToLoginAndFallbackColorWithNoLastMessageFields()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new ViewerStore(documentStore);

    // A chatter with no chat message at all (defensive shape — see ChatterDocument's nullable
    // last-message fields): UpsertChatterAsync always seeds them today, so this exercises the
    // fallback path directly against the document.
    await using (var session = documentStore.LightweightSession())
    {
      session.Insert(new ChatterDocument
      {
        Login = "lurker",
        FirstSeenAt = DateTimeOffset.UtcNow,
        MessageCount = 0,
        LastSeenAt = null,
        LastDisplayName = null,
        LastColor = null,
        LastBadgesJson = null,
      });
      await session.SaveChangesAsync();
    }

    var roster = await store.GetRosterAsync(CancellationToken.None);

    var entry = Assert.Single(roster);
    Assert.Equal("lurker", entry.Display);
    Assert.Equal(Narya.Core.Viewers.ViewerRoles.FallbackColor("lurker"), entry.Color);
    Assert.Empty(entry.Roles);
    Assert.Equal(entry.FirstSeenAt, entry.LastSeenAt); // falls back to FirstSeenAt
  }

  [Fact]
  public async Task GetRosterMergesViewerProfileNotes()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var chatStore = new ChatStore(documentStore);
    var store = new ViewerStore(documentStore);
    await chatStore.UpsertChatterAsync("viewer", DateTimeOffset.UtcNow, "Viewer", null, null, CancellationToken.None);
    _ = await store.UpsertProfileAsync("viewer", "", [], "a helpful note", DateTimeOffset.UtcNow, CancellationToken.None);

    var roster = await store.GetRosterAsync(CancellationToken.None);

    var entry = Assert.Single(roster);
    Assert.Equal("a helpful note", entry.Note);
  }

  [Fact]
  public async Task GetRosterOrdersByLastSeenAtDescending()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var chatStore = new ChatStore(documentStore);
    var store = new ViewerStore(documentStore);
    var now = DateTimeOffset.UtcNow;

    await chatStore.UpsertChatterAsync("older", now.AddMinutes(-10), "Older", null, null, CancellationToken.None);
    await chatStore.UpsertChatterAsync("newer", now, "Newer", null, null, CancellationToken.None);

    var roster = await store.GetRosterAsync(CancellationToken.None);

    Assert.Equal(["newer", "older"], roster.Select(r => r.Login));
  }

  // --- GetRecentViewersAsync -----------------------------------------------------------------

  [Fact]
  public async Task GetRecentViewersGroupsMessagesByLoginAndCapsRecentAtFive()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var chatStore = new ChatStore(documentStore);
    var store = new ViewerStore(documentStore);
    var start = DateTimeOffset.UtcNow;

    await chatStore.UpsertChatterAsync("viewer", start, "Viewer", "#111111", null, CancellationToken.None);

    for (var i = 0; i < 7; i++)
    {
      _ = await chatStore.TryInsertMessageAsync(
        BuildMessage($"msg-{i}", "viewer", start.AddSeconds(i), message: $"message {i}"), CancellationToken.None);
    }

    var viewers = await store.GetRecentViewersAsync(500, CancellationToken.None);

    var viewer = Assert.Single(viewers).Value;
    Assert.Equal(5, viewer.Recent.Count);
    // Newest-first within the capped 5 — the most recent message ingested is message 6.
    Assert.Equal("message 6", viewer.Recent[0].Text);
  }

  [Fact]
  public async Task GetRecentViewersDerivesSubbedFromTheSubscriberBadge()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var chatStore = new ChatStore(documentStore);
    var store = new ViewerStore(documentStore);
    var now = DateTimeOffset.UtcNow;

    await chatStore.UpsertChatterAsync("subviewer", now, "SubViewer", null, null, CancellationToken.None);
    _ = await chatStore.TryInsertMessageAsync(
      BuildMessage("msg-1", "subviewer", now, badges: new Dictionary<string, string> { ["subscriber"] = "6" }),
      CancellationToken.None);

    var viewers = await store.GetRecentViewersAsync(500, CancellationToken.None);

    var viewer = Assert.Single(viewers).Value;
    Assert.Equal("subscriber badge present", viewer.Subbed);
    Assert.Equal("not available", viewer.Followed);
    Assert.Equal("not available", viewer.AccountAge);
    Assert.Contains("sub", viewer.Roles);
  }

  [Fact]
  public async Task GetRecentViewersSkipsAUsernameNotInChattersDefensively()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var chatStore = new ChatStore(documentStore);
    var store = new ViewerStore(documentStore);
    var now = DateTimeOffset.UtcNow;

    // A chat_messages row with no corresponding chatters row (should not happen in practice,
    // but the projection guards it defensively — same as legacy's `if (!count) continue;`).
    await using (var session = documentStore.LightweightSession())
    {
      session.Insert(new ChatMessageDocument
      {
        Id = "msg-orphan",
        Channel = "codeacula",
        Username = "ghost",
        DisplayName = "Ghost",
        Message = "boo",
        ReceivedAt = now,
        ChatterUserId = "ghost-id",
      });
      await session.SaveChangesAsync();
    }

    var viewers = await store.GetRecentViewersAsync(500, CancellationToken.None);

    Assert.Empty(viewers);
  }

  [Fact]
  public async Task GetRecentViewersFallsBackToFallbackColorWhenMessageHasNoColor()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var chatStore = new ChatStore(documentStore);
    var store = new ViewerStore(documentStore);
    var now = DateTimeOffset.UtcNow;

    await chatStore.UpsertChatterAsync("nocolor", now, "NoColor", null, null, CancellationToken.None);
    _ = await chatStore.TryInsertMessageAsync(BuildMessage("msg-1", "nocolor", now, color: null), CancellationToken.None);

    var viewers = await store.GetRecentViewersAsync(500, CancellationToken.None);

    var viewer = Assert.Single(viewers).Value;
    Assert.Equal(Narya.Core.Viewers.ViewerRoles.FallbackColor("nocolor"), viewer.Color);
  }
}
