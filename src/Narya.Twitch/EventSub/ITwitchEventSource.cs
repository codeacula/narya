namespace Narya.Twitch.EventSub;

/// <summary>
/// The port the rest of the app drives the Twitch EventSub connection through. Phase 2
/// Task 3 (OAuth routes) only needs to trigger a reconnect after the broadcaster grants new
/// scopes, and a disconnect on broadcaster sign-out — it depends on this interface, defined
/// here as a minimal stub, so those routes don't have to wait on the real transport. Phase 2
/// Task 5 implements <c>TwitchEventSubWebSocket</c> against this same contract and replaces
/// the no-op registration (see <see cref="NoopTwitchEventSource"/>) in
/// <c>ServiceCollectionExtensions.AddNaryaTwitch</c>.
/// </summary>
public interface ITwitchEventSource
{
  Task StartAsync(CancellationToken cancellationToken);

  Task StopAsync();

  Task ReconnectAsync();
}
