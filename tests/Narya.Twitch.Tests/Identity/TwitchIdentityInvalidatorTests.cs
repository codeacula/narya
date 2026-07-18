using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;
using NSubstitute.ExceptionExtensions;

using Narya.Twitch.Identity;

namespace Narya.Twitch.Tests.Identity;

/// <summary>
/// The fan-out contract of <see cref="TwitchIdentityInvalidator"/>: one signal reaches every
/// registered cache, and one cache failing cannot leave the others holding stale identity — a
/// half-invalidated process (fresh broadcaster id, stale bot login) is exactly the state this
/// mechanism exists to prevent.
/// </summary>
public sealed class TwitchIdentityInvalidatorTests
{
  private static TwitchIdentityInvalidator Build(params ITwitchIdentityCache[] caches) =>
    new(caches, NullLogger<TwitchIdentityInvalidator>.Instance);

  [Fact]
  public async Task InvalidatesEveryRegisteredCacheExactlyOnce()
  {
    var first = Substitute.For<ITwitchIdentityCache>();
    var second = Substitute.For<ITwitchIdentityCache>();
    var third = Substitute.For<ITwitchIdentityCache>();

    await Build(first, second, third).InvalidateAsync(CancellationToken.None);

    await first.Received(1).InvalidateAsync(Arg.Any<CancellationToken>());
    await second.Received(1).InvalidateAsync(Arg.Any<CancellationToken>());
    await third.Received(1).InvalidateAsync(Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task OneFailingCacheDoesNotStopTheOthersOrSurfaceToTheCaller()
  {
    var failing = Substitute.For<ITwitchIdentityCache>();
    _ = failing.InvalidateAsync(Arg.Any<CancellationToken>()).ThrowsAsync(new InvalidOperationException("boom"));
    var healthy = Substitute.For<ITwitchIdentityCache>();

    // No throw: this runs after the config write or token save it reacts to has already
    // committed, so surfacing would turn a successful save into a 500.
    await Build(failing, healthy).InvalidateAsync(CancellationToken.None);

    await healthy.Received(1).InvalidateAsync(Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task NoRegisteredCachesIsANoOp()
  {
    // A host that composed AddNaryaTwitch without the real EventSub transport still resolves
    // this type; an empty enumerable must not be an error.
    await Build().InvalidateAsync(CancellationToken.None);
  }
}
