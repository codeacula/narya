namespace Narya.Twitch;

/// <summary>
/// The OAuth scopes each Twitch account needs, copied VERBATIM from
/// <c>legacy/src/server/twitch/auth.ts:9-32</c> (<c>REQUIRED_TWITCH_OAUTH_SCOPES</c> /
/// <c>REQUIRED_TWITCH_BOT_OAUTH_SCOPES</c>). A missing scope does not fail loudly — it
/// silently breaks whichever Helix call needed it — so these lists must be edited only by
/// copying the legacy source again, never from memory.
/// </summary>
public static class Scopes
{
  public static readonly IReadOnlyList<string> Broadcaster =
  [
    "moderator:read:followers",
    "moderator:read:chatters",
    "channel:read:subscriptions",
    "bits:read",
    "channel:manage:redemptions",
    "channel:read:ads",
    "channel:edit:commercial",
    "channel:manage:broadcast",
    "moderator:manage:banned_users",
    "moderator:manage:automod",
    "moderator:manage:shoutouts",
    "channel:manage:vips",
    "channel:manage:moderators",
    "user:read:chat",
    "user:write:chat",
    "user:manage:whispers",
    "user:read:whispers",
  ];

  public static readonly IReadOnlyList<string> Bot =
  [
    "user:read:chat",
    "user:write:chat",
  ];
}
