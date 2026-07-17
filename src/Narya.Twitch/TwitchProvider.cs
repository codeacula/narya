namespace Narya.Twitch;

/// <summary>
/// The two Twitch accounts Narya authenticates as: the broadcaster (channel owner, used
/// for channel management + most Helix calls) and the bot (a separate account that sends
/// chat messages so they aren't attributed to the broadcaster).
/// </summary>
public enum TwitchProvider
{
  Broadcaster = 0,
  Bot = 1,
}
