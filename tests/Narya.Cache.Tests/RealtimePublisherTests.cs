using System.Text.Json;

using StackExchange.Redis;

using Narya.Cache.Tests.Fixtures;
using Narya.Core.AppConfig;

namespace Narya.Cache.Tests;

/// <summary>
/// Proves <see cref="RealtimePublisher"/> puts the ACTUAL payload data on the wire, not an
/// empty object — the exact failure mode of System.Text.Json's classic pitfall
/// (serializing by a value's static/declared type rather than its runtime type, which
/// drops every member the declared type doesn't itself declare). Publishes a real
/// <see cref="AppConfigResponse"/> and subscribes with a raw <see cref="ConnectionMultiplexer"/>
/// to observe exactly what crosses the wire.
/// </summary>
public sealed class RealtimePublisherTests(RedisFixture fixture) : IClassFixture<RedisFixture>
{
  [Fact]
  public async Task PublishesEnvelopeWithRuntimeTypedPayloadNotEmptyObject()
  {
    var publisher = new RealtimePublisher(fixture.Multiplexer);
    var subscriber = fixture.Multiplexer.GetSubscriber();
    var channel = RedisChannel.Literal("narya:realtime");

    var received = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
    await subscriber.SubscribeAsync(channel, (_, message) => received.TrySetResult(message.ToString()));

    try
    {
      // `payload` below is declared `object`, exactly like
      // IRealtimePublisher.PublishAsync's parameter — this is the shape every real caller
      // (RealtimeBridgeHandler<T> forwarding IRealtimeNotification.Payload) actually
      // passes through.
      object payload = new AppConfigResponse
      {
        TwitchChannel = "codeacula",
        TwitchClientSecretConfigured = true,
      };

      await publisher.PublishAsync("settings:updated", payload, CancellationToken.None);

      var json = await received.Task.WaitAsync(TimeSpan.FromSeconds(10));

      // The headline assertion: the config value actually made it onto the wire.
      Assert.Contains("codeacula", json);
      Assert.DoesNotContain("\"payload\":{}", json);

      using var envelope = JsonDocument.Parse(json);
      var root = envelope.RootElement;

      Assert.Equal("settings:updated", root.GetProperty("event").GetString());

      var payloadElement = root.GetProperty("payload");
      Assert.Equal("codeacula", payloadElement.GetProperty("twitchChannel").GetString());
      Assert.True(payloadElement.GetProperty("twitchClientSecretConfigured").GetBoolean());

      // The masked response type must never leak a secret value onto the wire either —
      // same load-bearing property this repo already checks at the Application layer
      // (UpdateAppConfigCommandTests.MasksSecretsInTheResponse), now proven again at the
      // realtime-publish boundary.
      Assert.False(payloadElement.TryGetProperty("twitchClientSecret", out _));
    }
    finally
    {
      await subscriber.UnsubscribeAsync(channel);
    }
  }
}
