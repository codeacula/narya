namespace Narya.Twitch.Identity;

/// <summary>
/// Implemented by every singleton in <c>Narya.Twitch</c> that holds Twitch identity in memory
/// for the process lifetime: <see cref="Helix.HelixClient"/> (the resolved broadcaster id),
/// <see cref="Tokens.TwitchCredentials"/> (the app access token and its own copy of the
/// broadcaster id), and <see cref="EventSub.TwitchEventSubService"/> (the bot login the
/// bot-loop guard compares against, plus the subscribed-session bookkeeping).
///
/// The point of the shared interface is that <see cref="TwitchIdentityInvalidator"/> can take
/// <c>IEnumerable&lt;ITwitchIdentityCache&gt;</c> and stay correct as caches are added or
/// removed — no call site anywhere enumerates the caches by hand, which is exactly the
/// "sprinkled cache-clearing calls" failure mode this replaces. It also means a host that did
/// not opt into the real EventSub transport
/// (<c>ServiceCollectionExtensions.AddNaryaTwitchEventSub</c>) simply contributes one fewer
/// registration rather than needing a null EventSub cache of its own.
/// </summary>
public interface ITwitchIdentityCache
{
  /// <summary>
  /// Drops this component's cached identity so the next call re-resolves it. Asynchronous only
  /// because the EventSub implementation also has to start a reconnect — the two pure-cache
  /// implementations complete synchronously. Must not throw: it runs after the write that
  /// triggered it already committed (see
  /// <see cref="Core.Twitch.ITwitchIdentityInvalidator.InvalidateAsync"/>).
  /// </summary>
  Task InvalidateAsync(CancellationToken cancellationToken);
}
