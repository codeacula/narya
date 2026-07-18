using TwitchLib.EventSub.Websockets;

namespace Narya.Twitch.EventSub;

/// <summary>
/// The three imperative operations <see cref="TwitchEventSubService"/> drives on TwitchLib's
/// <see cref="EventSubWebsocketClient"/>, plus the session id it reads back.
///
/// <para>
/// <b>Why this exists.</b> <see cref="EventSubWebsocketClient"/> is a concrete class with no
/// virtual members, so it cannot be substituted — which meant the reconnect machinery
/// (<see cref="TwitchEventSubService.ReconnectWithBackoffAsync"/> and everything that requests a
/// reconnect) had no observable outcome a test could assert on without opening a real socket to
/// Twitch. The previous answer was a production-side counter field incremented purely so tests
/// could read it; a review correctly rejected that, because a counter records that a request was
/// MADE, not that a reconnect OCCURRED — code that increments a counter and then does nothing
/// passes just as well.
/// </para>
///
/// <para>
/// Deliberately covers ONLY the imperative calls. The ~20 event handlers stay wired directly onto
/// the concrete client in <see cref="TwitchEventSubService"/>'s constructor: they are TwitchLib's
/// own delegate types, re-declaring them here would be a large surface with no test value, and
/// tests already drive those handlers by invoking the service's own internal handler methods.
/// </para>
/// </summary>
public interface IEventSubSocket
{
  /// <summary>The current session id, or empty before the first session is established.</summary>
  string SessionId { get; }

  /// <summary>Opens the first connection. Returns false when the connect failed.</summary>
  Task<bool> ConnectAsync();

  /// <summary>
  /// The ONLY supported recovery path — never a <c>DisconnectAsync</c>/<c>ConnectAsync</c> pair
  /// (TwitchLib.EventSub.Websockets issue #37: that sequence leaves the socket unable to start
  /// again). Returns false when the attempt failed and should be retried.
  /// </summary>
  Task<bool> ReconnectAsync();

  /// <summary>Closes the connection at shutdown.</summary>
  Task<bool> DisconnectAsync();
}

/// <summary>
/// The production <see cref="IEventSubSocket"/>: a direct pass-through to the DI-registered
/// TwitchLib <see cref="EventSubWebsocketClient"/> singleton — the SAME instance
/// <see cref="TwitchEventSubService"/> wires its event handlers onto, so the socket this drives
/// and the socket those handlers fire from are never two different objects.
/// </summary>
internal sealed class EventSubSocket(EventSubWebsocketClient client) : IEventSubSocket
{
  public string SessionId => client.SessionId;

  public Task<bool> ConnectAsync() => client.ConnectAsync();

  public Task<bool> ReconnectAsync() => client.ReconnectAsync();

  public Task<bool> DisconnectAsync() => client.DisconnectAsync();
}
