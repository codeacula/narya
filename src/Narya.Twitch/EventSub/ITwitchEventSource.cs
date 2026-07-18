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

  /// <summary>
  /// A point-in-time snapshot of the connection state — see <see cref="EventSubStatus"/>. Added
  /// in Phase 3 Task 7 so <c>Narya.Twitch.Dashboard.TwitchDashboardStatusProvider</c> can read it
  /// through this same port rather than depending on <see cref="TwitchEventSubService"/>
  /// directly, which is registered only when a host opts into the real transport
  /// (<see cref="ServiceCollectionExtensions.AddNaryaTwitchEventSub"/>). <see cref="NoopTwitchEventSource"/>
  /// returns <see cref="EventSubStatus.Initial"/> (not connected) — the correct answer for a host
  /// with no live socket.
  /// </summary>
  EventSubStatus Status { get; }
}
