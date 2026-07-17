using FluentResults;

namespace Narya.Twitch.Tokens;

/// <summary>
/// The event-sourced store for the broadcaster + bot OAuth tokens. Implemented in
/// Narya.Twitch itself (<c>TwitchTokenStore</c>) — later Phase 2 tasks (OAuth routes,
/// credential resolution) depend on this interface rather than the concrete store.
/// </summary>
public interface ITwitchTokenStore
{
  Task<Result<TwitchToken?>> GetAsync(TwitchProvider provider, CancellationToken cancellationToken);

  Task<Result> SaveAsync(TwitchProvider provider, TwitchToken token, CancellationToken cancellationToken);

  Task<Result> DeleteAsync(TwitchProvider provider, CancellationToken cancellationToken);
}
