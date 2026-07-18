using Narya.Twitch.Chat;

namespace Narya.Twitch.Tests.Chat;

/// <summary>
/// <see cref="ChatRoleResolver"/> is a port of legacy's <c>getRoleFromBadges</c>
/// (<c>legacy/src/shared/roles.ts</c>) — first-match priority order: broadcaster beats
/// moderator beats VIP beats subscriber beats regular. Both overloads (badges dictionary,
/// and the boolean flags <c>channel.chat.message</c> carries directly) must agree on the same
/// priority.
/// </summary>
public sealed class ChatRoleResolverTests
{
  [Fact]
  public void NullBadgesResolveToRegular()
  {
    Assert.Equal(ChatRole.Regular, ChatRoleResolver.ResolveRole(null));
  }

  [Fact]
  public void EmptyBadgesResolveToRegular()
  {
    Assert.Equal(ChatRole.Regular, ChatRoleResolver.ResolveRole(new Dictionary<string, string>()));
  }

  [Fact]
  public void BroadcasterBadgeWinsOverEverythingElse()
  {
    var badges = new Dictionary<string, string>
    {
      ["broadcaster"] = "1",
      ["moderator"] = "1",
      ["vip"] = "1",
      ["subscriber"] = "12",
    };

    Assert.Equal(ChatRole.Broadcaster, ChatRoleResolver.ResolveRole(badges));
  }

  [Fact]
  public void ModeratorBadgeWinsOverVipAndSubscriber()
  {
    var badges = new Dictionary<string, string>
    {
      ["moderator"] = "1",
      ["vip"] = "1",
      ["subscriber"] = "12",
    };

    Assert.Equal(ChatRole.Moderator, ChatRoleResolver.ResolveRole(badges));
  }

  [Fact]
  public void VipBadgeWinsOverSubscriber()
  {
    var badges = new Dictionary<string, string>
    {
      ["vip"] = "1",
      ["subscriber"] = "12",
    };

    Assert.Equal(ChatRole.Vip, ChatRoleResolver.ResolveRole(badges));
  }

  [Fact]
  public void SubscriberBadgeAloneResolvesToSubscriber()
  {
    var badges = new Dictionary<string, string> { ["subscriber"] = "12" };

    Assert.Equal(ChatRole.Subscriber, ChatRoleResolver.ResolveRole(badges));
  }

  [Fact]
  public void UnrelatedBadgesResolveToRegular()
  {
    var badges = new Dictionary<string, string> { ["premium"] = "1", ["glitchcon2020"] = "1" };

    Assert.Equal(ChatRole.Regular, ChatRoleResolver.ResolveRole(badges));
  }

  [Theory]
  [InlineData(true, true, true, true, ChatRole.Broadcaster)]
  [InlineData(false, true, true, true, ChatRole.Moderator)]
  [InlineData(false, false, true, true, ChatRole.Vip)]
  [InlineData(false, false, false, true, ChatRole.Subscriber)]
  [InlineData(false, false, false, false, ChatRole.Regular)]
  public void FlagsOverloadUsesTheSamePriorityOrder(
    bool isBroadcaster, bool isModerator, bool isVip, bool isSubscriber, ChatRole expected)
  {
    Assert.Equal(expected, ChatRoleResolver.ResolveRole(isBroadcaster, isModerator, isVip, isSubscriber));
  }

  [Fact]
  public void BothOverloadsAgreeForTheSameChatter()
  {
    var badges = new Dictionary<string, string> { ["moderator"] = "1", ["subscriber"] = "6" };

    var fromBadges = ChatRoleResolver.ResolveRole(badges);
    var fromFlags = ChatRoleResolver.ResolveRole(isBroadcaster: false, isModerator: true, isVip: false, isSubscriber: true);

    Assert.Equal(fromBadges, fromFlags);
  }

  [Fact]
  public void ResolveAllRolesReturnsEveryRoleInPriorityOrderExcludingRegular()
  {
    var badges = new Dictionary<string, string>
    {
      ["broadcaster"] = "1",
      ["vip"] = "1",
      ["subscriber"] = "12",
    };

    var roles = ChatRoleResolver.ResolveAllRoles(badges);

    Assert.Equal([ChatRole.Broadcaster, ChatRole.Vip, ChatRole.Subscriber], roles);
  }

  [Fact]
  public void ResolveAllRolesReturnsEmptyForNullBadges()
  {
    Assert.Empty(ChatRoleResolver.ResolveAllRoles(null));
  }

  [Fact]
  public void InstanceImplementsTheInterfaceByDelegatingToTheStaticLogic()
  {
    IChatRoleResolver resolver = new ChatRoleResolver();
    var badges = new Dictionary<string, string> { ["vip"] = "1" };

    Assert.Equal(ChatRole.Vip, resolver.Resolve(badges));
    Assert.Equal(ChatRole.Broadcaster, resolver.Resolve(true, false, false, false));
    Assert.Equal([ChatRole.Vip], resolver.ResolveAll(badges));
  }
}
