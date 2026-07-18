using MediatR;

using Narya.Core.Dashboard;
using Narya.Core.Events;
using Narya.Core.Sessions;

namespace Narya.Application.Dashboard;

/// <summary>
/// A port of legacy's <c>GET /api/dashboard/session-shoutouts</c> — see
/// <see cref="GetSessionShoutoutsQueryHandler"/> for the grouping logic
/// (<c>legacy/src/server/dashboard/status.ts</c>'s <c>getSessionShoutouts</c>).
/// </summary>
public sealed record GetSessionShoutoutsQuery : IRequest<IReadOnlyList<SessionShoutout>>;

/// <summary>
/// Groups the current session's thank-worthy stream events per actor. Empty when there is no
/// active stream session — matches legacy exactly (a redelivered/rewatched follow-up outside a
/// session has nothing to attach to).
/// </summary>
public sealed class GetSessionShoutoutsQueryHandler(IStreamEventStore eventStore, IStreamSessionStore sessionStore)
  : IRequestHandler<GetSessionShoutoutsQuery, IReadOnlyList<SessionShoutout>>
{
  /// <summary>
  /// Matches legacy's <c>THANK_WORTHY_EVENT_KINDS</c> (<c>legacy/src/shared/constants.ts</c>) —
  /// deliberately excludes <c>ad_break</c>, which is not something to thank a viewer for.
  /// </summary>
  public static readonly IReadOnlyList<string> ThankWorthyKinds = ["follow", "sub", "gift", "cheer", "raid", "redeem"];

  public async Task<IReadOnlyList<SessionShoutout>> Handle(GetSessionShoutoutsQuery request, CancellationToken cancellationToken)
  {
    var sessionId = await sessionStore.GetCurrentSessionIdAsync(cancellationToken).ConfigureAwait(false);
    if (sessionId is null)
    {
      return [];
    }

    var events = await eventStore.GetSessionShoutoutEventsAsync(sessionId, ThankWorthyKinds, cancellationToken)
      .ConfigureAwait(false);

    // events arrives oldest→newest (IStreamEventStore.GetSessionShoutoutEventsAsync's contract),
    // which is load-bearing here: the LAST row processed for a given actor is always their most
    // recent event, so overwriting Detail/LastAt on every match (rather than only when "newer")
    // is correct without an extra comparison.
    var byActor = new Dictionary<string, SessionShoutout>(StringComparer.Ordinal);

    foreach (var e in events)
    {
      // Group by login where we have one; older rows fall back to the (lowercased) display name
      // — mirrors legacy's `row.login ?? row.actor.toLowerCase()`. ActorLogin is already
      // lowercased by PersistStreamEventHandler before it is ever stored, so it is used as-is.
      var key = e.ActorLogin ?? e.Actor.ToLowerInvariant();

      if (!byActor.TryGetValue(key, out var existing))
      {
        byActor[key] = new SessionShoutout(
          Actor: e.Actor,
          Login: e.ActorLogin,
          Kinds: [e.Kind],
          Detail: e.Detail,
          FirstAt: e.ReceivedAt,
          LastAt: e.ReceivedAt);
        continue;
      }

      var kinds = existing.Kinds.Contains(e.Kind, StringComparer.Ordinal)
        ? existing.Kinds
        : [.. existing.Kinds, e.Kind];

      byActor[key] = existing with
      {
        Kinds = kinds,
        Detail = e.Detail, // most-recent wins — "a resub says more than the follow that preceded it"
        LastAt = e.ReceivedAt,
        Login = existing.Login ?? e.ActorLogin,
      };
    }

    return [.. byActor.Values.OrderByDescending(s => s.LastAt)];
  }
}
