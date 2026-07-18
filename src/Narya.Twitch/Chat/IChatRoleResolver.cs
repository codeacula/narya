namespace Narya.Twitch.Chat;

/// <summary>
/// A chatter's role, in first-match priority order (broadcaster beats moderator beats VIP
/// beats subscriber beats regular) — a port of legacy's <c>Role</c> union
/// (<c>legacy/src/shared/roles.ts</c>).
/// </summary>
public enum ChatRole
{
  Broadcaster = 0,
  Moderator = 1,
  Vip = 2,
  Subscriber = 3,
  Regular = 4,
}

/// <summary>
/// Resolves a chatter's <see cref="ChatRole"/> from either their raw chat badges (the
/// <c>channel.chat.message_delete</c>/<c>clear</c>/<c>clear_user_messages</c> family, and any
/// consumer working from a persisted <see cref="ChatMessage.Badges"/>) or the boolean flags
/// <c>channel.chat.message</c> carries directly on its payload
/// (<c>ChannelChatMessage.IsBroadcaster</c>/<c>IsModerator</c>/<c>IsVip</c>/<c>IsSubscriber</c>
/// — themselves computed by TwitchLib from the same badges, per Step 0's decompile findings).
/// Both overloads apply the identical priority order; see <see cref="ChatRoleResolver"/>'s
/// static methods for the pure logic both this interface and
/// <see cref="EventSub.EventSubDispatcher"/> share.
/// </summary>
public interface IChatRoleResolver
{
  ChatRole Resolve(IReadOnlyDictionary<string, string>? badges);

  ChatRole Resolve(bool isBroadcaster, bool isModerator, bool isVip, bool isSubscriber);

  /// <summary>Every role a chatter holds, not just the highest-priority one — a port of legacy's <c>getViewerRolesFromBadges</c>.</summary>
  IReadOnlyList<ChatRole> ResolveAll(IReadOnlyDictionary<string, string>? badges);
}
