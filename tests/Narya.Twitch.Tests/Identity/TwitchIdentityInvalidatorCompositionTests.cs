using Marten;

using Microsoft.Extensions.DependencyInjection;

using NSubstitute;

using Narya.Application;
using Narya.Core.AppConfig;
using Narya.Core.Twitch;
using Narya.Twitch.Helix;
using Narya.Twitch.Identity;
using Narya.Twitch.Tokens;

namespace Narya.Twitch.Tests.Identity;

/// <summary>
/// The Twitch half of the composition contract <c>AddNaryaApplication</c>'s
/// <c>TryAddSingleton&lt;NullTwitchIdentityInvalidator&gt;</c> creates: the real
/// <see cref="TwitchIdentityInvalidator"/> must win in a host composing both layers, in EITHER
/// call order, and its cache list must be the SAME singletons everything else resolves — a
/// second, separately-constructed <see cref="HelixClient"/> would have its own broadcaster-id
/// field, so invalidating it would clear nothing any caller reads. Same shape as
/// <c>Narya.Application.Tests.Realtime.RealtimePublisherCompositionTests</c>.
/// </summary>
public sealed class TwitchIdentityInvalidatorCompositionTests
{
  private static ServiceProvider BuildProvider(bool twitchFirst)
  {
    var services = new ServiceCollection();
    _ = services.AddLogging();
    _ = services.AddSingleton(Substitute.For<IDocumentStore>());
    _ = services.AddSingleton(Substitute.For<IAppConfigStore>());

    if (twitchFirst)
    {
      _ = services.AddNaryaTwitch();
      _ = services.AddNaryaApplication();
    }
    else
    {
      _ = services.AddNaryaApplication();
      _ = services.AddNaryaTwitch();
    }

    return services.BuildServiceProvider();
  }

  [Theory]
  [InlineData(true)]
  [InlineData(false)]
  public async Task TheRealInvalidatorWinsOverTheApplicationDefaultInEitherCompositionOrder(bool twitchFirst)
  {
    await using var provider = BuildProvider(twitchFirst);

    _ = Assert.IsType<TwitchIdentityInvalidator>(provider.GetRequiredService<ITwitchIdentityInvalidator>());
  }

  [Fact]
  public async Task TheRegisteredCachesAreTheSameSingletonsTheRestOfTheGraphResolves()
  {
    await using var provider = BuildProvider(twitchFirst: true);

    var caches = provider.GetServices<ITwitchIdentityCache>().ToList();

    // Two without the real EventSub transport (AddNaryaTwitchEventSub adds the third) — and
    // both must be the very instances IHelixClient/ITwitchCredentials resolve to.
    Assert.Equal(2, caches.Count);
    Assert.Contains(caches, c => ReferenceEquals(c, provider.GetRequiredService<IHelixClient>()));
    Assert.Contains(caches, c => ReferenceEquals(c, provider.GetRequiredService<ITwitchCredentials>()));
  }
}
