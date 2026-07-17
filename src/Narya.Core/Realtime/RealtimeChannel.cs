namespace Narya.Core.Realtime;

/// <summary>
/// The single Redis pub/sub channel every realtime envelope travels on. Shared by the
/// publisher (<c>Narya.Cache.RealtimePublisher</c>) and the broadcaster
/// (<c>Narya.Api.Realtime.RealtimeBroadcastService</c>) so both sides name the channel
/// identically without either depending on the other's assembly.
/// </summary>
public static class RealtimeChannel
{
  public const string Name = "narya:realtime";
}
