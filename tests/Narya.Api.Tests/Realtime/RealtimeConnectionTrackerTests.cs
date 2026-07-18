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

    tracker.Add("conn-1", isOperator: true);
    tracker.Add("conn-2", isOperator: false);

    Assert.Equal(2, tracker.Count);
  }

  [Fact]
  public void AddingTheSameConnectionIdTwiceCountsItOnce()
  {
    var tracker = new RealtimeConnectionTracker();

    tracker.Add("conn-1", isOperator: true);
    tracker.Add("conn-1", isOperator: true);

    Assert.Equal(1, tracker.Count);
  }

  [Fact]
  public void RemoveDecrementsCount()
  {
    var tracker = new RealtimeConnectionTracker();
    tracker.Add("conn-1", isOperator: true);
    tracker.Add("conn-2", isOperator: false);

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
    tracker.Add("conn-1", isOperator: true);

    tracker.Remove("never-added");

    Assert.Equal(1, tracker.Count);
  }

  // ---------------------------------------------------------------------------------------
  // OperatorCount — see the class's doc comment for why DashboardHeartbeatService gates on
  // this, not Count: dashboard:status is operator-only, so an overlay connection must not
  // keep the heartbeat awake.
  // ---------------------------------------------------------------------------------------

  [Fact]
  public void OperatorCountStartsAtZero()
  {
    var tracker = new RealtimeConnectionTracker();

    Assert.Equal(0, tracker.OperatorCount);
  }

  [Fact]
  public void OperatorCountIgnoresOverlayOnlyConnections()
  {
    var tracker = new RealtimeConnectionTracker();

    tracker.Add("overlay-1", isOperator: false);
    tracker.Add("overlay-2", isOperator: false);

    Assert.Equal(2, tracker.Count);
    Assert.Equal(0, tracker.OperatorCount);
  }

  [Fact]
  public void OperatorCountCountsOnlyOperatorConnectionsAmongAMix()
  {
    var tracker = new RealtimeConnectionTracker();

    tracker.Add("overlay-1", isOperator: false);
    tracker.Add("operator-1", isOperator: true);
    tracker.Add("operator-2", isOperator: true);

    Assert.Equal(3, tracker.Count);
    Assert.Equal(2, tracker.OperatorCount);
  }

  [Fact]
  public void RemovingAnOperatorConnectionDecrementsOperatorCount()
  {
    var tracker = new RealtimeConnectionTracker();
    tracker.Add("operator-1", isOperator: true);
    tracker.Add("overlay-1", isOperator: false);

    tracker.Remove("operator-1");

    Assert.Equal(1, tracker.Count);
    Assert.Equal(0, tracker.OperatorCount);
  }
}
