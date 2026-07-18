using Marten;

using Narya.Core.Chat;
using Narya.Database.Chat;
using Narya.Database.Tests.Fixtures;
using Narya.Database.Viewers;

namespace Narya.Database.Tests.Chat;

[Collection("postgres")]
public sealed class ChatStoreTests(PostgresFixture fixture)
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
    string id = "msg-1",
    string username = "viewer",
    DateTimeOffset? receivedAt = null,
    IReadOnlyDictionary<string, string>? badges = null) =>
    new(
      Id: id,
      Channel: "codeacula",
      Username: username,
      DisplayName: username,
      Color: "#ff0000",
      Message: "hello chat",
      ReceivedAt: receivedAt ?? DateTimeOffset.UtcNow,
      Badges: badges,
      ChatterUserId: $"{username}-id");

  [Fact]
  public async Task AppendChatEventAlwaysInsertsANewRowEvenForTheSameMessage()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new ChatStore(documentStore);
    var occurredAt = DateTimeOffset.UtcNow;

    _ = await store.AppendChatEventAsync(
      "message.created", "codeacula", "{}", "msg-1", "viewer", occurredAt, CancellationToken.None);
    _ = await store.AppendChatEventAsync(
      "message.created", "codeacula", "{}", "msg-1", "viewer", occurredAt, CancellationToken.None);

    var events = await store.GetRecentEventsAsync(100, CancellationToken.None);

    Assert.Equal(2, events.Count);
  }

  [Fact]
  public async Task TryInsertMessageReturnsTrueOnFirstInsertAndFalseOnRedelivery()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new ChatStore(documentStore);
    var original = BuildMessage() with { Message = "original text" };

    var first = await store.TryInsertMessageAsync(original, CancellationToken.None);
    var redelivered = await store.TryInsertMessageAsync(original with { Message = "tampered text" }, CancellationToken.None);

    Assert.True(first);
    Assert.False(redelivered);

    var recent = await store.GetRecentMessagesAsync(40, CancellationToken.None);
    var stored = Assert.Single(recent);
    Assert.Equal("original text", stored.Message); // the redelivery must not have overwritten it
  }

  [Fact]
  public async Task HasSeenChatterBeforeReflectsWhetherAChattersDocExists()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new ChatStore(documentStore);

    var before = await store.HasSeenChatterBeforeAsync("viewer", CancellationToken.None);
    await store.UpsertChatterAsync("viewer", DateTimeOffset.UtcNow, "Viewer", null, null, CancellationToken.None);
    var after = await store.HasSeenChatterBeforeAsync("VIEWER", CancellationToken.None); // case-insensitive

    Assert.False(before);
    Assert.True(after);
  }

  [Fact]
  public async Task UpsertChatterInsertsFirstThenIncrementsPreservingFirstSeenAt()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new ChatStore(documentStore);
    var firstSeenAt = DateTimeOffset.UtcNow;
    var secondMessageAt = firstSeenAt.AddMinutes(5);

    await store.UpsertChatterAsync("viewer", firstSeenAt, "Viewer", "#111111", null, CancellationToken.None);
    await store.UpsertChatterAsync(
      "viewer", secondMessageAt, "ViewerNewCasing", "#222222",
      new Dictionary<string, string> { ["subscriber"] = "1" }, CancellationToken.None);

    await using var query = documentStore.QuerySession();
    var doc = await query.LoadAsync<ChatterDocument>("viewer");

    Assert.NotNull(doc);
    Assert.Equal(2, doc!.MessageCount);
    Assert.Equal(firstSeenAt, doc.FirstSeenAt); // untouched by the second call
    Assert.Equal(secondMessageAt, doc.LastSeenAt);
    Assert.Equal("ViewerNewCasing", doc.LastDisplayName);
    Assert.Equal("#222222", doc.LastColor);
    Assert.Contains("subscriber", doc.LastBadgesJson);
  }

  [Fact]
  public async Task GetRecentMessagesReturnsOldestToNewestCappedAtLimit()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new ChatStore(documentStore);
    var start = DateTimeOffset.UtcNow;

    for (var i = 0; i < 5; i++)
    {
      _ = await store.TryInsertMessageAsync(
        BuildMessage(id: $"msg-{i}", receivedAt: start.AddSeconds(i)), CancellationToken.None);
    }

    var recent = await store.GetRecentMessagesAsync(3, CancellationToken.None);

    Assert.Equal(3, recent.Count);
    Assert.Equal(["msg-2", "msg-3", "msg-4"], recent.Select(m => m.Id));
  }

  [Fact]
  public async Task GetRecentMessagesOmitsSessionIdAndRoundTripsBadges()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new ChatStore(documentStore);
    var withSessionAndBadges = BuildMessage(badges: new Dictionary<string, string> { ["moderator"] = "1" }) with
    {
      SessionId = "session-1",
      IsFirstThisSession = true,
      IsFirstEver = true,
      IsFirstTimer = true,
    };

    _ = await store.TryInsertMessageAsync(withSessionAndBadges, CancellationToken.None);

    var recent = await store.GetRecentMessagesAsync(40, CancellationToken.None);
    var stored = Assert.Single(recent);

    Assert.Null(stored.SessionId); // deliberately omitted on this route, matching legacy
    Assert.True(stored.IsFirstThisSession);
    Assert.True(stored.IsFirstEver);
    Assert.True(stored.IsFirstTimer);
    Assert.NotNull(stored.Badges);
    Assert.Equal("1", stored.Badges!["moderator"]);
  }

  [Fact]
  public async Task GetRecentEventsReturnsOldestToNewestCappedAtLimit()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new ChatStore(documentStore);
    var start = DateTimeOffset.UtcNow;

    for (var i = 0; i < 5; i++)
    {
      _ = await store.AppendChatEventAsync(
        "message.created", "codeacula", $"{{\"n\":{i}}}", $"msg-{i}", "viewer", start.AddSeconds(i), CancellationToken.None);
    }

    var recent = await store.GetRecentEventsAsync(3, CancellationToken.None);

    Assert.Equal(3, recent.Count);
    Assert.Equal(["msg-2", "msg-3", "msg-4"], recent.Select(e => e.MessageId));
    Assert.Equal(2, recent[0].Payload.GetProperty("n").GetInt32());
  }
}
