using Narya.Api.Realtime;

namespace Narya.Api.Tests.Realtime;

public sealed class RealtimeConnectionTrackerTests
{
  [Fact]
  public void CountStartsAtZero()
  {
    var tracker = new RealtimeConnectionTracker();

    Assert.Equal(0, tracker.Count);
  }

  [Fact]
  public void AddIncrementsCountPerDistinctConnectionId()
  {
    var tracker = new RealtimeConnectionTracker();

    tracker.Add("conn-1");
    tracker.Add("conn-2");

    Assert.Equal(2, tracker.Count);
  }

  [Fact]
  public void AddingTheSameConnectionIdTwiceCountsItOnce()
  {
    var tracker = new RealtimeConnectionTracker();

    tracker.Add("conn-1");
    tracker.Add("conn-1");

    Assert.Equal(1, tracker.Count);
  }

  [Fact]
  public void RemoveDecrementsCount()
  {
    var tracker = new RealtimeConnectionTracker();
    tracker.Add("conn-1");
    tracker.Add("conn-2");

    tracker.Remove("conn-1");

    Assert.Equal(1, tracker.Count);
  }

  /// <summary>
  /// A connection <see cref="RealtimeHub.OnConnectedAsync"/> rejected (<c>Context.Abort()</c>,
  /// never added) still runs <see cref="RealtimeHub.OnDisconnectedAsync"/> — removing an id that
  /// was never added must be a safe no-op, not go negative. See the class's doc comment.
  /// </summary>
  [Fact]
  public void RemovingAnUnknownConnectionIdIsANoOp()
  {
    var tracker = new RealtimeConnectionTracker();
    tracker.Add("conn-1");

    tracker.Remove("never-added");

    Assert.Equal(1, tracker.Count);
  }
}
