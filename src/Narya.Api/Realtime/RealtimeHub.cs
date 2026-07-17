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
/// SignalR convention for this exact situation. Only that token is trusted; no header is
/// consulted for role or client IP.
/// </summary>
public sealed class RealtimeHub(DashboardTokenAuthenticator authenticator) : Hub
{
  public const string OperatorGroup = "operator";
  public const string OverlayGroup = "overlay";

  public override async Task OnConnectedAsync()
  {
    var token = Context.GetHttpContext()?.Request.Query["access_token"].ToString();

    switch (authenticator.ResolveRole(string.IsNullOrEmpty(token) ? null : token))
    {
      case DashboardTokenAuthenticator.OperatorRole:
        // Operators join ONLY the operator group. RealtimeBroadcastService always sends
        // to the operator group, so this alone already means "operators see everything" —
        // also joining the overlay group would double-deliver every allowlisted event.
        await Groups.AddToGroupAsync(Context.ConnectionId, OperatorGroup).ConfigureAwait(false);
        break;

      case DashboardTokenAuthenticator.OverlayRole:
        await Groups.AddToGroupAsync(Context.ConnectionId, OverlayGroup).ConfigureAwait(false);
        break;

      default:
        // Reject unauthenticated. No token, an unrecognized token, or no dashboard
        // token configured at all (HasDashboardToken == false) all resolve to a null
        // role here — none of them get a connection.
        Context.Abort();
        return;
    }

    await base.OnConnectedAsync().ConfigureAwait(false);
  }
}
