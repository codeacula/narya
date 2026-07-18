using System.Collections.Concurrent;

namespace Narya.Api.Realtime;

/// <summary>
/// Tracks how many SignalR clients (operator + overlay combined) currently hold an accepted
/// connection to <see cref="RealtimeHub"/>. The sole consumer is
/// <c>Narya.Api.Dashboard.DashboardHeartbeatService</c>'s "skip broadcasting <c>dashboard:status</c>
/// when nobody is listening" decision — a port of legacy's <c>getSocketCount()</c>
/// (<c>legacy/src/server/realtime.ts</c>), so a dashboard nobody has open does not pay the cost
/// of building and publishing a snapshot every <c>DashboardHeartbeatService.Interval</c>.
///
/// Keyed by SignalR connection id (a <see cref="ConcurrentDictionary{TKey,TValue}"/>, not a
/// plain counter) rather than a bare <c>Interlocked</c> increment/decrement, specifically so an
/// unbalanced call is self-correcting: <see cref="RealtimeHub.OnConnectedAsync"/> only calls
/// <see cref="Add"/> on the accepted (operator/overlay) branches, never the rejected
/// (<c>Context.Abort()</c>) branch, but <see cref="RealtimeHub.OnDisconnectedAsync"/> calls
/// <see cref="Remove"/> unconditionally for every connection, accepted or not — SignalR still
/// runs the hub's disconnect path for a connection aborted during <c>OnConnectedAsync</c>. A
/// bare counter would go negative in that case; removing a connection id that was never added is
/// a no-op here.
/// </summary>
public sealed class RealtimeConnectionTracker
{
  private readonly ConcurrentDictionary<string, byte> _connectionIds = new(StringComparer.Ordinal);

  public int Count => _connectionIds.Count;

  public void Add(string connectionId) => _connectionIds[connectionId] = 0;

  public void Remove(string connectionId) => _connectionIds.TryRemove(connectionId, out _);
}
