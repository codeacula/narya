namespace Narya.Twitch.EventSub;

/// <summary>
/// Default <see cref="ITwitchEventSource"/> registered by <c>AddNaryaTwitch</c> via
/// <c>TryAddSingleton</c> until Phase 2 Task 5 lands the real WebSocket transport and
/// replaces this registration. Every call is a no-op: the OAuth callback and sign-out routes
/// can call <see cref="ITwitchEventSource.ReconnectAsync"/> / <see cref="ITwitchEventSource.StopAsync"/>
/// unconditionally today without anything actually connecting to Twitch.
/// </summary>
public sealed class NoopTwitchEventSource : ITwitchEventSource
{
  public Task StartAsync(CancellationToken cancellationToken) => Task.CompletedTask;

  public Task StopAsync() => Task.CompletedTask;

  public Task ReconnectAsync() => Task.CompletedTask;
}
