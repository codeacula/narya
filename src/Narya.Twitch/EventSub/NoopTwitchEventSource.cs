namespace Narya.Twitch.EventSub;

/// <summary>
/// Default <see cref="ITwitchEventSource"/> registered by <c>AddNaryaTwitch</c> via
/// <c>TryAddSingleton</c> — every call is a no-op. A host that also calls
/// <c>ServiceCollectionExtensions.AddNaryaTwitchEventSub</c> replaces this with the real
/// <see cref="TwitchEventSource"/>; one that does not (unit tests that call
/// <c>AddNaryaTwitch</c> directly, a future Agent host with no socket of its own) resolves
/// this instead, so the OAuth callback and sign-out routes can call
/// <see cref="ITwitchEventSource.ReconnectAsync"/> / <see cref="ITwitchEventSource.StopAsync"/>
/// unconditionally without anything actually connecting to Twitch.
/// </summary>
public sealed class NoopTwitchEventSource : ITwitchEventSource
{
  public Task StartAsync(CancellationToken cancellationToken) => Task.CompletedTask;

  public Task StopAsync() => Task.CompletedTask;

  public Task ReconnectAsync() => Task.CompletedTask;

  public EventSubStatus Status => EventSubStatus.Initial;
}
