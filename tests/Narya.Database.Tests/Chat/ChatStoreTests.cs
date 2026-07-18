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
    string channel = "codeacula",
    DateTimeOffset? receivedAt = null,
    IReadOnlyDictionary<string, string>? badges = null) =>
    new(
      Id: id,
      Channel: channel,
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

  [Fact]
  public async Task MarkMessageDeletedMarksOnlyThatRowAndLinksModerationEvent()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new ChatStore(documentStore);
    _ = await store.TryInsertMessageAsync(BuildMessage(id: "msg-1"), CancellationToken.None);
    _ = await store.TryInsertMessageAsync(BuildMessage(id: "msg-2"), CancellationToken.None);
    var deletedAt = DateTimeOffset.UtcNow;
    var moderationEventId = Guid.NewGuid();

    var affected = await store.MarkMessageDeletedAsync(
      "msg-1", deletedAt, "message deleted by moderator", moderationEventId, CancellationToken.None);

    Assert.Equal(1, affected);

    await using var query = documentStore.QuerySession();
    var deleted = await query.LoadAsync<ChatMessageDocument>("msg-1");
    var untouched = await query.LoadAsync<ChatMessageDocument>("msg-2");

    Assert.NotNull(deleted);
    Assert.Equal(deletedAt, deleted!.DeletedAt);
    Assert.Equal("message deleted by moderator", deleted.DeletedReason);
    Assert.Equal(moderationEventId.ToString(), deleted.ModerationEventId);

    Assert.NotNull(untouched);
    Assert.Null(untouched!.DeletedAt);
    Assert.Null(untouched.DeletedReason);
    Assert.Null(untouched.ModerationEventId);
  }

  [Fact]
  public async Task MarkMessageDeletedReturnsZeroForAnUnknownId()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new ChatStore(documentStore);

    var affected = await store.MarkMessageDeletedAsync(
      "does-not-exist", DateTimeOffset.UtcNow, "message deleted by moderator", Guid.NewGuid(), CancellationToken.None);

    Assert.Equal(0, affected);
  }

  [Fact]
  public async Task MarkMessageDeletedOverwritesAnAlreadyDeletedRowWithNoIsNullGuard()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new ChatStore(documentStore);
    _ = await store.TryInsertMessageAsync(BuildMessage(id: "msg-1"), CancellationToken.None);
    var firstDeletedAt = DateTimeOffset.UtcNow;
    var firstEventId = Guid.NewGuid();
    _ = await store.MarkMessageDeletedAsync("msg-1", firstDeletedAt, "message deleted by moderator", firstEventId, CancellationToken.None);

    // Re-applying against the SAME already-deleted row must succeed and overwrite — unlike the
    // by-user/by-channel ops, this single-id statement has no `DeletedAt is null` guard.
    var secondDeletedAt = firstDeletedAt.AddSeconds(5);
    var secondEventId = Guid.NewGuid();
    var affected = await store.MarkMessageDeletedAsync(
      "msg-1", secondDeletedAt, "chat cleared", secondEventId, CancellationToken.None);

    Assert.Equal(1, affected);

    await using var query = documentStore.QuerySession();
    var doc = await query.LoadAsync<ChatMessageDocument>("msg-1");

    Assert.NotNull(doc);
    Assert.Equal(secondDeletedAt, doc!.DeletedAt);
    Assert.Equal("chat cleared", doc.DeletedReason);
    Assert.Equal(secondEventId.ToString(), doc.ModerationEventId);
  }

  [Fact]
  public async Task MarkUserMessagesDeletedMarksAllThatUsersUndeletedRowsInTheChannelCaseInsensitively()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new ChatStore(documentStore);
    _ = await store.TryInsertMessageAsync(BuildMessage(id: "msg-1", username: "rowdyviewer"), CancellationToken.None);
    _ = await store.TryInsertMessageAsync(BuildMessage(id: "msg-2", username: "rowdyviewer"), CancellationToken.None);
    _ = await store.TryInsertMessageAsync(BuildMessage(id: "msg-3", username: "someoneelse"), CancellationToken.None);
    var deletedAt = DateTimeOffset.UtcNow;
    var moderationEventId = Guid.NewGuid();

    var affected = await store.MarkUserMessagesDeletedAsync(
      "codeacula", "RowdyViewer", deletedAt, "timeout: no reason provided", moderationEventId, CancellationToken.None);

    Assert.Equal(2, affected);

    await using var query = documentStore.QuerySession();
    var msg1 = await query.LoadAsync<ChatMessageDocument>("msg-1");
    var msg2 = await query.LoadAsync<ChatMessageDocument>("msg-2");
    var msg3 = await query.LoadAsync<ChatMessageDocument>("msg-3");

    Assert.Equal(deletedAt, msg1!.DeletedAt);
    Assert.Equal(deletedAt, msg2!.DeletedAt);
    Assert.Equal("timeout: no reason provided", msg1.DeletedReason);
    Assert.Equal(moderationEventId.ToString(), msg1.ModerationEventId);
    Assert.Null(msg3!.DeletedAt); // a different user in the same channel is untouched
  }

  [Fact]
  public async Task MarkUserMessagesDeletedOnlyTouchesStillUndeletedRowsOnRerun()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new ChatStore(documentStore);
    _ = await store.TryInsertMessageAsync(BuildMessage(id: "msg-1", username: "rowdyviewer"), CancellationToken.None);
    _ = await store.TryInsertMessageAsync(BuildMessage(id: "msg-2", username: "rowdyviewer"), CancellationToken.None);

    // Seed msg-1 as already deleted by an EARLIER moderation event, before the redelivered
    // timeout arrives.
    var earlierDeletedAt = DateTimeOffset.UtcNow.AddMinutes(-1);
    var earlierEventId = Guid.NewGuid();
    _ = await store.MarkMessageDeletedAsync("msg-1", earlierDeletedAt, "message deleted by moderator", earlierEventId, CancellationToken.None);

    var redeliveredDeletedAt = DateTimeOffset.UtcNow;
    var redeliveredEventId = Guid.NewGuid();
    var affected = await store.MarkUserMessagesDeletedAsync(
      "codeacula", "rowdyviewer", redeliveredDeletedAt, "timeout: no reason provided", redeliveredEventId, CancellationToken.None);

    Assert.Equal(1, affected); // only msg-2 — msg-1 was already deleted, so the filter skips it

    await using var query = documentStore.QuerySession();
    var msg1 = await query.LoadAsync<ChatMessageDocument>("msg-1");
    var msg2 = await query.LoadAsync<ChatMessageDocument>("msg-2");

    // msg-1's original soft-delete is untouched by the rerun.
    Assert.Equal(earlierDeletedAt, msg1!.DeletedAt);
    Assert.Equal("message deleted by moderator", msg1.DeletedReason);
    Assert.Equal(earlierEventId.ToString(), msg1.ModerationEventId);

    Assert.Equal(redeliveredDeletedAt, msg2!.DeletedAt);
    Assert.Equal(redeliveredEventId.ToString(), msg2.ModerationEventId);
  }

  [Fact]
  public async Task MarkChannelMessagesDeletedMarksAllUndeletedRowsInThatChannelOnly()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new ChatStore(documentStore);
    _ = await store.TryInsertMessageAsync(BuildMessage(id: "msg-1", channel: "codeacula"), CancellationToken.None);
    _ = await store.TryInsertMessageAsync(BuildMessage(id: "msg-2", username: "other", channel: "codeacula"), CancellationToken.None);
    _ = await store.TryInsertMessageAsync(BuildMessage(id: "msg-3", channel: "someone-else"), CancellationToken.None);
    var deletedAt = DateTimeOffset.UtcNow;
    var moderationEventId = Guid.NewGuid();

    var affected = await store.MarkChannelMessagesDeletedAsync(
      "codeacula", deletedAt, "chat cleared", moderationEventId, CancellationToken.None);

    Assert.Equal(2, affected);

    await using var query = documentStore.QuerySession();
    var msg1 = await query.LoadAsync<ChatMessageDocument>("msg-1");
    var msg2 = await query.LoadAsync<ChatMessageDocument>("msg-2");
    var msg3 = await query.LoadAsync<ChatMessageDocument>("msg-3");

    Assert.Equal(deletedAt, msg1!.DeletedAt);
    Assert.Equal("chat cleared", msg1.DeletedReason);
    Assert.Equal(deletedAt, msg2!.DeletedAt);
    Assert.Null(msg3!.DeletedAt); // a different channel is untouched
  }

  [Fact]
  public async Task MarkChannelMessagesDeletedOnlyTouchesStillUndeletedRowsOnRerun()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new ChatStore(documentStore);
    _ = await store.TryInsertMessageAsync(BuildMessage(id: "msg-1"), CancellationToken.None);
    _ = await store.TryInsertMessageAsync(BuildMessage(id: "msg-2", username: "other"), CancellationToken.None);
    var earlierEventId = Guid.NewGuid();
    _ = await store.MarkMessageDeletedAsync(
      "msg-1", DateTimeOffset.UtcNow.AddMinutes(-1), "message deleted by moderator", earlierEventId, CancellationToken.None);

    var affected = await store.MarkChannelMessagesDeletedAsync(
      "codeacula", DateTimeOffset.UtcNow, "chat cleared", Guid.NewGuid(), CancellationToken.None);

    Assert.Equal(1, affected); // only msg-2 — msg-1 was already deleted

    await using var query = documentStore.QuerySession();
    var msg1 = await query.LoadAsync<ChatMessageDocument>("msg-1");

    Assert.Equal("message deleted by moderator", msg1!.DeletedReason); // untouched by the rerun
    Assert.Equal(earlierEventId.ToString(), msg1.ModerationEventId);
  }

  [Fact]
  public async Task GetMessagesByUsernameReturnsOnlyThatUsersMessagesOldestToNewest()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new ChatStore(documentStore);
    var start = DateTimeOffset.UtcNow;

    _ = await store.TryInsertMessageAsync(BuildMessage(id: "a-1", username: "alice", receivedAt: start), CancellationToken.None);
    _ = await store.TryInsertMessageAsync(BuildMessage(id: "b-1", username: "bob", receivedAt: start.AddSeconds(1)), CancellationToken.None);
    _ = await store.TryInsertMessageAsync(BuildMessage(id: "a-2", username: "alice", receivedAt: start.AddSeconds(2)), CancellationToken.None);

    var page = await store.GetMessagesByUsernameAsync("alice", null, 80, CancellationToken.None);

    // Not leaked: bob's message never appears on alice's page.
    Assert.Equal(["a-1", "a-2"], page.Select(m => m.Id));
  }

  [Fact]
  public async Task GetMessagesByUsernameIsCaseInsensitive()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new ChatStore(documentStore);
    _ = await store.TryInsertMessageAsync(BuildMessage(id: "msg-1", username: "alice"), CancellationToken.None);

    var page = await store.GetMessagesByUsernameAsync("ALICE", null, 80, CancellationToken.None);

    _ = Assert.Single(page);
  }

  [Fact]
  public async Task GetMessagesByUsernamePaginatesStrictlyBeforeTheAnchor()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new ChatStore(documentStore);
    var start = DateTimeOffset.UtcNow;

    for (var i = 0; i < 5; i++)
    {
      _ = await store.TryInsertMessageAsync(
        BuildMessage(id: $"msg-{i}", username: "alice", receivedAt: start.AddSeconds(i)), CancellationToken.None);
    }

    var firstPage = await store.GetMessagesByUsernameAsync("alice", null, 3, CancellationToken.None);
    Assert.Equal(["msg-2", "msg-3", "msg-4"], firstPage.Select(m => m.Id));

    var secondPage = await store.GetMessagesByUsernameAsync("alice", "msg-2", 3, CancellationToken.None);
    Assert.Equal(["msg-0", "msg-1"], secondPage.Select(m => m.Id));
  }

  [Fact]
  public async Task GetMessagesByUsernameWithAnUnknownBeforeIdReturnsTheNewestPage()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new ChatStore(documentStore);
    _ = await store.TryInsertMessageAsync(BuildMessage(id: "msg-1", username: "alice"), CancellationToken.None);

    var page = await store.GetMessagesByUsernameAsync("alice", "does-not-exist", 80, CancellationToken.None);

    _ = Assert.Single(page);
  }

  [Fact]
  public async Task GetMessagesByUsernameIncludesSessionIdUnlikeGetRecentMessages()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new ChatStore(documentStore);
    var withSession = BuildMessage(id: "msg-1", username: "alice") with { SessionId = "session-1" };
    _ = await store.TryInsertMessageAsync(withSession, CancellationToken.None);

    var page = await store.GetMessagesByUsernameAsync("alice", null, 80, CancellationToken.None);

    var stored = Assert.Single(page);
    Assert.Equal("session-1", stored.SessionId);
  }

  [Fact]
  public async Task GetActiveChatterCountCountsDistinctUsernamesSinceTheCutoff()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new ChatStore(documentStore);
    var now = DateTimeOffset.UtcNow;

    // Two messages from the same user within the window count once.
    _ = await store.TryInsertMessageAsync(
      BuildMessage(id: "msg-1", username: "alice", receivedAt: now.AddMinutes(-1)), CancellationToken.None);
    _ = await store.TryInsertMessageAsync(
      BuildMessage(id: "msg-2", username: "alice", receivedAt: now), CancellationToken.None);
    // A different user, also within the window.
    _ = await store.TryInsertMessageAsync(
      BuildMessage(id: "msg-3", username: "bob", receivedAt: now.AddMinutes(-2)), CancellationToken.None);
    // Outside the window entirely.
    _ = await store.TryInsertMessageAsync(
      BuildMessage(id: "msg-4", username: "carol", receivedAt: now.AddMinutes(-30)), CancellationToken.None);

    var count = await store.GetActiveChatterCountAsync(now.AddMinutes(-15), CancellationToken.None);

    Assert.Equal(2, count); // alice, bob — carol is outside the window
  }

  [Fact]
  public async Task GetActiveChatterCountIsZeroWhenNoMessagesAreWithinTheWindow()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new ChatStore(documentStore);
    var now = DateTimeOffset.UtcNow;
    _ = await store.TryInsertMessageAsync(
      BuildMessage(id: "msg-1", username: "alice", receivedAt: now.AddHours(-1)), CancellationToken.None);

    var count = await store.GetActiveChatterCountAsync(now.AddMinutes(-15), CancellationToken.None);

    Assert.Equal(0, count);
  }

  [Fact]
  public async Task GetKnownChatterCountReturnsTheChattersRowCount()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new ChatStore(documentStore);
    await store.UpsertChatterAsync("alice", DateTimeOffset.UtcNow, "Alice", null, null, CancellationToken.None);
    await store.UpsertChatterAsync("bob", DateTimeOffset.UtcNow, "Bob", null, null, CancellationToken.None);
    // A second message from an already-known chatter must not inflate the count.
    await store.UpsertChatterAsync("alice", DateTimeOffset.UtcNow, "Alice", null, null, CancellationToken.None);

    var count = await store.GetKnownChatterCountAsync(CancellationToken.None);

    Assert.Equal(2, count);
  }

  [Fact]
  public async Task GetKnownChatterCountIsZeroWhenNoChattersExist()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new ChatStore(documentStore);

    var count = await store.GetKnownChatterCountAsync(CancellationToken.None);

    Assert.Equal(0, count);
  }
}
