using Microsoft.Extensions.DependencyInjection;

using Narya.Core.Twitch;

namespace Narya.Application.Tests.Twitch;

/// <summary>
/// The <c>Narya.Agent</c> half of the composition contract for
/// <see cref="ITwitchIdentityInvalidator"/> — the same shape as
/// <c>Realtime.RealtimePublisherCompositionTests</c>. <c>UpdateAppConfigCommandHandler</c> now
/// hard-depends on this port, so a host that composes <c>AddNaryaApplication()</c> WITHOUT
/// <c>AddNaryaTwitch()</c> (the Agent host, which must build without the Twitch layer; a
/// WebApplicationFactory test under <c>Narya:SkipInfrastructure</c>) would otherwise fail to
/// construct that handler at all. The mirror-image assertion — that <c>AddNaryaTwitch</c>'s real
/// implementation wins in either composition order — lives in
/// <c>Narya.Twitch.Tests.Identity.TwitchIdentityInvalidatorCompositionTests</c>, since this test
/// project deliberately does not reference <c>Narya.Twitch</c>.
/// </summary>
public sealed class TwitchIdentityInvalidatorCompositionTests
{
  [Fact]
  public async Task ApplicationAloneResolvesTheNoOpInvalidatorAndDoesNotThrow()
  {
    var services = new ServiceCollection();
    _ = services.AddLogging();
    _ = services.AddNaryaApplication();

    await using var provider = services.BuildServiceProvider();
    var invalidator = provider.GetRequiredService<ITwitchIdentityInvalidator>();

    _ = Assert.IsType<NullTwitchIdentityInvalidator>(invalidator);
    var exception = await Record.ExceptionAsync(() => invalidator.InvalidateAsync(CancellationToken.None));
    Assert.Null(exception);
  }
}
