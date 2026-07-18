using Microsoft.Extensions.Logging;

using Narya.Core.Twitch;

namespace Narya.Twitch.Identity;

/// <summary>
/// The real <see cref="ITwitchIdentityInvalidator"/>: fans one invalidation signal out to every
/// registered <see cref="ITwitchIdentityCache"/>. Registered with a plain <c>AddSingleton</c> in
/// <c>AddNaryaTwitch</c>, which therefore always wins over <c>AddNaryaApplication</c>'s
/// <c>TryAddSingleton&lt;NullTwitchIdentityInvalidator&gt;</c> default regardless of the order
/// the two extension methods run in.
///
/// One <c>await</c> loop rather than <c>Task.WhenAll</c>: there are three caches, each is
/// effectively instantaneous (two field assignments and one guarded fire-and-forget reconnect),
/// and running them in sequence means a cache that somehow throws is attributed to itself in
/// the log rather than arriving inside an <see cref="AggregateException"/>. Each cache is
/// wrapped individually so one failure cannot stop the others from being cleared — a
/// half-invalidated process (new broadcaster id, stale bot login) is the exact state this whole
/// mechanism exists to prevent.
/// </summary>
public sealed partial class TwitchIdentityInvalidator(
  IEnumerable<ITwitchIdentityCache> caches,
  ILogger<TwitchIdentityInvalidator> logger) : ITwitchIdentityInvalidator
{
  public async Task InvalidateAsync(CancellationToken cancellationToken)
  {
    LogInvalidating(logger);

    foreach (var cache in caches)
    {
      try
      {
        await cache.InvalidateAsync(cancellationToken).ConfigureAwait(false);
      }
      catch (Exception ex)
      {
        // Deliberately broad and deliberately swallowed: this runs after the config write or
        // token save it reacts to has already committed, so surfacing it would turn a
        // successful save into a 500. See ITwitchIdentityInvalidator's doc comment.
        LogCacheInvalidationFailed(logger, cache.GetType().Name, ex);
      }
    }
  }

  [LoggerMessage(Level = LogLevel.Information, Message = "Twitch identity changed; invalidating cached broadcaster id, tokens, and bot login")]
  private static partial void LogInvalidating(ILogger logger);

  [LoggerMessage(Level = LogLevel.Warning, Message = "Failed to invalidate cached Twitch identity in {Cache}")]
  private static partial void LogCacheInvalidationFailed(ILogger logger, string cache, Exception exception);
}
