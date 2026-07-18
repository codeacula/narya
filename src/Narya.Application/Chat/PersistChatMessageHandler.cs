using System.Text.Json;

using MediatR;

using Narya.Core.AppConfig;
using Narya.Core.Chat;
using Narya.Core.Sessions;

namespace Narya.Application.Chat;

/// <summary>
/// Persists every ingested chat message and enriches it before broadcasting — a port of
/// legacy's <c>chat.ts</c> <c>message</c> handler. Mirrors that handler's five steps exactly,
/// reordered only where the load-bearing constraint ("chatters bump + broadcast only on a
/// genuine insert") allows: legacy appended the chat event, inserted (dedup'd) with the
/// enrichment already computed inline, then conditionally upserted the chatter and
/// unconditionally broadcast. This handler instead STOPS entirely on a redelivery — see
/// <see cref="Handle"/>'s doc comment on <see cref="IChatStore.TryInsertMessageAsync"/> for why
/// that's a deliberate strengthening over legacy, not a port of it: EventSub redelivery
/// (reconnects, at-least-once delivery) is a real concern this rewrite has to account for that
/// tmi.js's raw IRC connection never posed.
/// </summary>
public sealed class PersistChatMessageHandler(
  IChatStore chatStore,
  IStreamSessionStore sessionStore,
  IAppConfigStore appConfigStore,
  IMediator mediator) : INotificationHandler<ChatMessageIngestedNotification>
{
  public async Task Handle(ChatMessageIngestedNotification notification, CancellationToken cancellationToken)
  {
    var message = notification.Message;

    // Step 1: always append to the chat_events ledger, even on a redelivery — chat_events is
    // append-only with no natural key to dedup against (see ChatEventDocument's doc comment).
    _ = await chatStore.AppendChatEventAsync(
      "message.created",
      message.Channel,
      JsonSerializer.Serialize(message),
      message.Id,
      message.Username,
      message.ReceivedAt,
      cancellationToken).ConfigureAwait(false);

    // Step 2 (reordered ahead of the insert — see IChatStore.TryInsertMessageAsync's doc
    // comment): compute enrichment BEFORE attempting the insert, so the stored document is
    // already the enriched one rather than needing a second write. This is safe to do even on
    // a redelivery that will ultimately be discarded: HasSeenChatterBeforeAsync is a read, and
    // RecordCurrentSessionChatterAsync dedups on {sessionId}:{login} (not on message id), so a
    // repeat call for the same chatter is itself a harmless no-op.
    var isChannelOwner = await IsChannelOwnerAsync(message, cancellationToken).ConfigureAwait(false);

    var isFirstEver = false;
    if (!isChannelOwner)
    {
      var hasSeenBefore = await chatStore.HasSeenChatterBeforeAsync(message.Username, cancellationToken).ConfigureAwait(false);
      isFirstEver = !hasSeenBefore;
    }

    // The broadcaster is excluded from session-chatter tracking (so the dashboard doesn't count
    // them toward "who's chatting this session"), but their messages still belong to the live
    // session — otherwise the dashboard would render them as past-stream chat. Matches legacy's
    // chat.ts comment on this exact branch.
    var sessionResult = isChannelOwner
      ? new SessionChatterResult(await sessionStore.GetCurrentSessionIdAsync(cancellationToken).ConfigureAwait(false), false)
      : await sessionStore.RecordCurrentSessionChatterAsync(message.Username, message.Id, message.ReceivedAt, cancellationToken)
        .ConfigureAwait(false);

    // IsFirstTimer always mirrors IsFirstEver — see ChatMessage's doc comment; there is no
    // independent "first timer" signal in this domain.
    var enriched = message with
    {
      IsFirstTimer = isFirstEver,
      IsFirstEver = isFirstEver,
      IsFirstThisSession = sessionResult.IsFirstInSession,
      SessionId = sessionResult.SessionId,
    };

    // Step 3: insert-or-ignore the enriched message. False means this exact message id was
    // already stored — a redelivery — so we stop here: no chatters bump, no broadcast.
    var inserted = await chatStore.TryInsertMessageAsync(enriched, cancellationToken).ConfigureAwait(false);
    if (!inserted)
    {
      return;
    }

    // Step 4: fold into the chatters summary — only reached on a genuine insert.
    await chatStore.UpsertChatterAsync(
      enriched.Username, enriched.ReceivedAt, enriched.DisplayName, enriched.Color, enriched.Badges, cancellationToken)
      .ConfigureAwait(false);

    // Step 5: publish the enriched copy for the realtime bridge to broadcast as chat:message —
    // only reached on a genuine insert.
    await mediator.Publish(new ChatMessageBroadcastNotification(enriched), cancellationToken).ConfigureAwait(false);
  }

  /// <summary>
  /// A store failure here (e.g. the config document has never been written) falls back to an
  /// empty configured channel rather than throwing — nobody's username will ever equal the
  /// empty string, so this degrades to "nobody is the channel owner" rather than blocking chat
  /// ingestion entirely on an unrelated store's availability.
  /// </summary>
  private async Task<bool> IsChannelOwnerAsync(ChatMessage message, CancellationToken cancellationToken)
  {
    var configResult = await appConfigStore.GetAsync(cancellationToken).ConfigureAwait(false);
    var twitchChannel = configResult.IsFailed ? string.Empty : configResult.Value.TwitchChannel;

    return string.Equals(message.Username, twitchChannel, StringComparison.OrdinalIgnoreCase)
      || (message.Badges?.ContainsKey("broadcaster") ?? false);
  }
}
