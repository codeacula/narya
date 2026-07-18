using Microsoft.AspNetCore.SignalR;

using Narya.Api.Auth;

namespace Narya.Api.Realtime;

/// <summary>
/// The realtime WebSocket endpoint at <c>/hubs/realtime</c>. Not gated by
/// <see cref="DashboardTokenMiddleware"/> — that middleware is mounted only over
/// <c>/api</c> — so this hub authenticates the connection itself, using the SAME
/// <see cref="DashboardTokenAuthenticator"/> the HTTP middleware uses, so the two never
/// drift apart on what counts as a valid operator/overlay token.
///
/// SignalR has no request headers to piggyback auth on the way the HTTP middleware does
/// (a browser <c>EventSource</c>/WebSocket upgrade can't set an Authorization header), so
/// the token travels as the <c>access_token</c> query-string parameter — the standard
/// SignalR convention for this exact situation. No request header is trusted for the role. The
/// connection's peer address is consulted only for the no-token-configured loopback fallback
/// (<see cref="DashboardTokenAuthenticator.ResolveLoopbackRole"/>), and only after
/// <c>UseForwardedHeaders</c> has resolved it against the <see cref="TrustedProxies"/>
/// allowlist — a client-supplied <c>X-Forwarded-For</c> from an untrusted peer is ignored.
/// </summary>
public sealed class RealtimeHub(DashboardTokenAuthenticator authenticator, RealtimeConnectionTracker connectionTracker) : Hub
{
  public const string OperatorGroup = "operator";
  public const string OverlayGroup = "overlay";

  public override async Task OnConnectedAsync()
  {
    var httpContext = Context.GetHttpContext();
    var token = httpContext?.Request.Query["access_token"].ToString();

    var role = authenticator.ResolveRole(string.IsNullOrEmpty(token) ? null : token)
      // Loopback parity with DashboardTokenMiddleware. Without it the local no-token dashboard
      // could load REST data but never receive a single realtime update or heartbeat, because
      // ResolveRole always returns null when no token is configured. Same shared decision, so
      // the HTTP and SignalR paths cannot drift.
      ?? authenticator.ResolveLoopbackRole(httpContext?.Connection.RemoteIpAddress);

    switch (role)
    {
      case DashboardTokenAuthenticator.OperatorRole:
        // Operators join ONLY the operator group. RealtimeBroadcastService always sends
        // to the operator group, so this alone already means "operators see everything" —
        // also joining the overlay group would double-deliver every allowlisted event.
        await Groups.AddToGroupAsync(Context.ConnectionId, OperatorGroup).ConfigureAwait(false);
        connectionTracker.Add(Context.ConnectionId, isOperator: true);
        break;

      case DashboardTokenAuthenticator.OverlayRole:
        await Groups.AddToGroupAsync(Context.ConnectionId, OverlayGroup).ConfigureAwait(false);
        connectionTracker.Add(Context.ConnectionId, isOperator: false);
        break;

      default:
        // Reject unauthenticated. No token, an unrecognized token, or no dashboard token
        // configured at all with a non-loopback (or unknown) peer address all resolve to a
        // null role here — none of them get a connection. Deliberately NOT added to
        // connectionTracker — see that class's doc comment for why OnDisconnectedAsync
        // removing an id that was never added is still safe.
        Context.Abort();
        return;
    }

    await base.OnConnectedAsync().ConfigureAwait(false);
  }

  public override Task OnDisconnectedAsync(Exception? exception)
  {
    connectionTracker.Remove(Context.ConnectionId);
    return base.OnDisconnectedAsync(exception);
  }
}
