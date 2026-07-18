using TwitchLib.EventSub.Websockets;

namespace Narya.Twitch.EventSub;

/// <summary>
/// The real <see cref="ITwitchEventSource"/> — a thin pass-through to the singleton
/// <see cref="EventSubWebsocketClient"/> that <c>AddTwitchLibEventSubWebsockets()</c>
/// registers. All of the actual connection behavior — wiring the lifecycle handlers, deciding
/// when to re-subscribe, and running the hard-drop reconnect-with-backoff loop — lives in
/// <see cref="TwitchEventSubService"/>, which attaches to this same singleton's events exactly
/// once, in its constructor, independent of which caller drives Connect/Disconnect/Reconnect.
/// That means it does not matter whether <see cref="ReconnectAsync"/> is invoked from here (an
/// OAuth callback that just granted new scopes) or from <see cref="TwitchEventSubService"/>
/// itself (recovering from a hard drop) — either way the same handlers fire and run the same
/// re-subscribe decision, using whatever token <see cref="Tokens.ITwitchCredentials"/> resolves
/// at that moment.
///
/// Registered via <c>ServiceCollectionExtensions.AddNaryaTwitchEventSub</c>, which
/// <c>Replace</c>s the <see cref="NoopTwitchEventSource"/> default — never both at once.
/// </summary>
public sealed class TwitchEventSource(EventSubWebsocketClient client, TwitchEventSubService eventSubService) : ITwitchEventSource
{
  /// <summary>
  /// Exists for interface completeness — <see cref="TwitchEventSubService.ExecuteAsync"/> is
  /// the one place that actually connects the socket at boot, and no Phase 2 caller invokes
  /// this a second time on an already-connected client. Wire a caller through here only once
  /// that scenario has an actual test proving it is safe.
  /// </summary>
  public async Task StartAsync(CancellationToken cancellationToken) =>
    _ = await client.ConnectAsync().ConfigureAwait(false);

  public async Task StopAsync() =>
    _ = await client.DisconnectAsync().ConfigureAwait(false);

  public async Task ReconnectAsync() =>
    _ = await client.ReconnectAsync().ConfigureAwait(false);

  /// <summary>
  /// Delegates to the same <see cref="TwitchEventSubService"/> singleton
  /// <c>ServiceCollectionExtensions.AddNaryaTwitchEventSub</c> registers both as itself (for
  /// this) and as the hosted service that actually drives the connection — one instance, two
  /// registrations, so this always reports the real, live status regardless of which
  /// registration a caller resolved.
  /// </summary>
  public EventSubStatus Status => eventSubService.Status;
}
