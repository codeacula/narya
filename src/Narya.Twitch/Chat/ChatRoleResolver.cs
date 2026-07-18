namespace Narya.Twitch.Chat;

/// <summary>
/// <see cref="IChatRoleResolver"/>'s implementation. The resolution logic is exposed as
/// <c>static</c> methods (<see cref="ResolveRole(IReadOnlyDictionary{string,string}?)"/> and
/// overloads) specifically so <see cref="EventSub.EventSubDispatcher"/> — a pure, DI-free
/// static class by design (twitchlib-spec.md §4: "the dispatcher is a PURE function ... NO
/// I/O", which precludes taking a constructor-injected <see cref="IChatRoleResolver"/>
/// instance) — can call the identical role logic directly, with no DI container needed. The
/// instance members below exist purely to satisfy <see cref="IChatRoleResolver"/> for whatever
/// future phase needs it injected (a viewer-command role check, a dashboard viewer-roster
/// column); they delegate to the same static methods rather than duplicating the priority
/// order.
/// </summary>
public sealed class ChatRoleResolver : IChatRoleResolver
{
  public static ChatRole ResolveRole(IReadOnlyDictionary<string, string>? badges) => badges switch
  {
    null => ChatRole.Regular,
    _ when badges.ContainsKey("broadcaster") => ChatRole.Broadcaster,
    _ when badges.ContainsKey("moderator") => ChatRole.Moderator,
    _ when badges.ContainsKey("vip") => ChatRole.Vip,
    _ when badges.ContainsKey("subscriber") => ChatRole.Subscriber,
    _ => ChatRole.Regular,
  };

  public static ChatRole ResolveRole(bool isBroadcaster, bool isModerator, bool isVip, bool isSubscriber) => true switch
  {
    _ when isBroadcaster => ChatRole.Broadcaster,
    _ when isModerator => ChatRole.Moderator,
    _ when isVip => ChatRole.Vip,
    _ when isSubscriber => ChatRole.Subscriber,
    _ => ChatRole.Regular,
  };

  public static IReadOnlyList<ChatRole> ResolveAllRoles(IReadOnlyDictionary<string, string>? badges)
  {
    if (badges is null)
    {
      return [];
    }

    List<ChatRole> roles = [];

    if (badges.ContainsKey("broadcaster"))
    {
      roles.Add(ChatRole.Broadcaster);
    }

    if (badges.ContainsKey("moderator"))
    {
      roles.Add(ChatRole.Moderator);
    }

    if (badges.ContainsKey("vip"))
    {
      roles.Add(ChatRole.Vip);
    }

    if (badges.ContainsKey("subscriber"))
    {
      roles.Add(ChatRole.Subscriber);
    }

    return roles;
  }

  ChatRole IChatRoleResolver.Resolve(IReadOnlyDictionary<string, string>? badges) => ResolveRole(badges);

  ChatRole IChatRoleResolver.Resolve(bool isBroadcaster, bool isModerator, bool isVip, bool isSubscriber) =>
    ResolveRole(isBroadcaster, isModerator, isVip, isSubscriber);

  IReadOnlyList<ChatRole> IChatRoleResolver.ResolveAll(IReadOnlyDictionary<string, string>? badges) =>
    ResolveAllRoles(badges);
}
