using System.Text.Json;

using MediatR;

using Narya.Core.Chat;

namespace Narya.Application.Chat;

/// <summary>
/// Persists a chat moderation action and broadcasts it — a port of legacy's <c>chat.ts</c>
/// <c>messagedeleted</c>/<c>timeout</c>/<c>ban</c>/<c>clearchat</c> handlers, which all follow
/// the same shape: append a <c>chat_events</c> row, apply the soft-delete linked to that event's
/// id/timestamp, THEN broadcast. See <see cref="ChatModeratedNotification"/>'s doc comment for
/// why the broadcast is a separate, later notification rather than something this handler races
/// against.
/// </summary>
public sealed class PersistChatModerationHandler(IChatStore chatStore, IMediator mediator)
  : INotificationHandler<ChatModeratedNotification>
{
  public async Task Handle(ChatModeratedNotification notification, CancellationToken cancellationToken)
  {
    var moderationEvent = notification.ModerationEvent;

    // Step 1: append the chat_events ledger row. Its id becomes ModerationEventId and its
    // occurredAt becomes the soft-delete's DeletedAt — matches legacy's appendChatEvent, which
    // ran ahead of every mark*Deleted statement.
    var appended = await chatStore.AppendChatEventAsync(
      moderationEvent.Type,
      moderationEvent.Channel,
      JsonSerializer.Serialize(moderationEvent),
      moderationEvent.MessageId,
      moderationEvent.Username,
      moderationEvent.DeletedAt,
      cancellationToken).ConfigureAwait(false);

    // Step 2: resolve the final reason text purely from Type. `rawReason` is always null today —
    // Narya's EventSub dispatch has no source of ban/timeout reason text (channel.moderate v2 is
    // deferred, see EventSubDispatcher.DispatchChatClearUserMessages's doc comment) — but the
    // fallback is written explicitly (rather than a hardcoded final string) so a future phase
    // that threads a real reason through ChatModerationEvent only needs to supply it here, not
    // touch the format strings themselves.
    const string? rawReason = null;
    var deletedReason = FormatDeletedReason(moderationEvent.Type, rawReason);

    // Step 3: apply the soft-delete. Which store op runs is selected purely by Type — "honor the
    // type the notification carries" rather than trying to re-derive ban vs timeout.
    switch (moderationEvent.Type)
    {
      case "message.deleted":
        // Matches legacy's `if (messageId) { markMessageDeleted.run(...) }` — a delete event
        // without a target message id has nothing to soft-delete, but still gets persisted and
        // broadcast above/below.
        if (moderationEvent.MessageId is not null)
        {
          _ = await chatStore.MarkMessageDeletedAsync(
            moderationEvent.MessageId, appended.OccurredAt, deletedReason, appended.Id, cancellationToken)
            .ConfigureAwait(false);
        }

        break;

      case "user.timeout":
      case "user.ban":
        if (moderationEvent.Username is not null)
        {
          _ = await chatStore.MarkUserMessagesDeletedAsync(
            moderationEvent.Channel, moderationEvent.Username, appended.OccurredAt, deletedReason, appended.Id, cancellationToken)
            .ConfigureAwait(false);
        }

        break;

      case "chat.clear":
        _ = await chatStore.MarkChannelMessagesDeletedAsync(
          moderationEvent.Channel, appended.OccurredAt, deletedReason, appended.Id, cancellationToken)
          .ConfigureAwait(false);
        break;

      default:
        // Outside the closed set ChatModerationEvent.Type documents — nothing to soft-delete,
        // but the chat_events append and the broadcast below still happen unconditionally.
        break;
    }

    // Step 4: broadcast only after the soft-delete write above has completed, carrying the FINAL
    // persisted timestamp/reason — never the raw values the ingested notification arrived with.
    var broadcastEvent = moderationEvent with { DeletedAt = appended.OccurredAt, DeletedReason = deletedReason };
    await mediator.Publish(new ChatModeratedBroadcastNotification(broadcastEvent), cancellationToken).ConfigureAwait(false);
  }

  /// <summary>
  /// Mirrors legacy's per-handler reason strings exactly:
  /// <c>'message deleted by moderator'</c>, <c>`timeout: ${reason || 'no reason provided'}`</c>,
  /// <c>`ban: ${reason || 'no reason provided'}`</c>, <c>'chat cleared'</c>.
  /// </summary>
  private static string FormatDeletedReason(string type, string? reason) => type switch
  {
    "message.deleted" => "message deleted by moderator",
    "user.timeout" => $"timeout: {(string.IsNullOrEmpty(reason) ? "no reason provided" : reason)}",
    "user.ban" => $"ban: {(string.IsNullOrEmpty(reason) ? "no reason provided" : reason)}",
    "chat.clear" => "chat cleared",
    _ => "moderation action",
  };
}
