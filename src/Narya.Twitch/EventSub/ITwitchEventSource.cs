namespace Narya.Twitch.EventSub;

/// <summary>
/// The port the rest of the app drives the Twitch EventSub connection through. The OAuth
/// callback route triggers a reconnect after the broadcaster grants new scopes, and sign-out
/// triggers a disconnect. <see cref="NoopTwitchEventSource"/> is the default registration (a
/// host with no live socket — tests, the Agent host); <see cref="TwitchEventSource"/> is the
/// real implementation, wired over TwitchLib.EventSub.Websockets, that
/// <c>ServiceCollectionExtensions.AddNaryaTwitchEventSub</c> replaces it with — see that
/// method's doc comment for why the real transport is a separate opt-in from
/// <c>AddNaryaTwitch</c> rather than bundled into it.
/// </summary>
public interface ITwitchEventSource
{
  Task StartAsync(CancellationToken cancellationToken);

  Task StopAsync();

  Task ReconnectAsync();
}
