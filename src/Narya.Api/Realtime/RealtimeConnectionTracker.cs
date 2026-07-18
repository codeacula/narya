using System.Collections.Concurrent;

namespace Narya.Api.Realtime;

/// <summary>
/// Tracks how many SignalR clients currently hold an accepted connection to
/// <see cref="RealtimeHub"/>, and which role (operator vs overlay) each one authenticated as.
/// The sole consumer is <c>Narya.Api.Dashboard.DashboardHeartbeatService</c>'s "skip broadcasting
/// <c>dashboard:status</c> when nobody who can see it is listening" decision — a port of legacy's
/// <c>getSocketCount()</c> (<c>legacy/src/server/realtime.ts</c>), so a dashboard nobody has open
/// does not pay the cost of building and publishing a snapshot every
/// <c>DashboardHeartbeatService.Interval</c>.
///
/// <para>
/// <see cref="OperatorCount"/>, not <see cref="Count"/>, is what the heartbeat gates on:
/// <c>dashboard:status</c> is operator-only (it is never on
/// <see cref="Narya.Core.Realtime.RealtimeEventNames.OverlayAllowlist"/>), so a browser source
/// connected to <c>/overlay/*</c> for the whole stream — which holds an accepted SignalR
/// connection for hours — must not by itself keep the heartbeat awake. Before this distinction
/// existed, <see cref="Count"/> counted both roles, so an overlay-only stream still paid the
/// heartbeat's full cost (a status-query send plus a broadcast publish every 5 seconds) with zero
/// receivers who could ever see the result.
/// </para>
///
/// <para>
/// Keyed by SignalR connection id (a <see cref="ConcurrentDictionary{TKey,TValue}"/> mapping to
/// the connection's role, not a pair of bare <c>Interlocked</c> counters) specifically so an
/// unbalanced call is self-correcting: <see cref="RealtimeHub.OnConnectedAsync"/> only calls
/// <see cref="Add"/> on the accepted (operator/overlay) branches, never the rejected
/// (<c>Context.Abort()</c>) branch, but <see cref="RealtimeHub.OnDisconnectedAsync"/> calls
/// <see cref="Remove"/> unconditionally for every connection, accepted or not — SignalR still
/// runs the hub's disconnect path for a connection aborted during <c>OnConnectedAsync</c>. A bare
/// counter would go negative in that case; removing a connection id that was never added is a
/// no-op here.
/// </para>
/// </summary>
public sealed class RealtimeConnectionTracker
{
  private readonly ConcurrentDictionary<string, bool> _connections = new(StringComparer.Ordinal);

  /// <summary>Every connected client, operator + overlay combined.</summary>
  public int Count => _connections.Count;

  /// <summary>
  /// Operator-role connections only — see this class's doc comment for why
  /// <c>DashboardHeartbeatService.ShouldBroadcast</c> gates on this, not <see cref="Count"/>.
  /// </summary>
  public int OperatorCount => _connections.Values.Count(isOperator => isOperator);

  public void Add(string connectionId, bool isOperator) => _connections[connectionId] = isOperator;

  public void Remove(string connectionId) => _connections.TryRemove(connectionId, out _);
}
