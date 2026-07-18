namespace Narya.Core.Automod;

/// <summary>
/// Who produced a hold's resolution, and — because the values are ordered — which resolution wins
/// when two of them collide. Replaces the previous <c>bool authoritative</c> flag, which could
/// distinguish "speculative" from "authoritative" but NOT the two different authoritative sources
/// from each other, so two concurrent authoritative verdicts were resolved by arrival order
/// (last write wins) rather than by a rule.
///
/// <para>
/// <b>Precedence is the enum's own order</b> (<see cref="Speculative"/> &lt;
/// <see cref="Dashboard"/> &lt; <see cref="EventSub"/>) and the operator decision behind it is:
/// <b>EventSub wins.</b> Twitch's own <c>automod.message.update</c> is the system of record for
/// whether a message was actually held or released; a dashboard-derived verdict is this app's
/// report of a Helix call it made, which Twitch may subsequently have overridden. So an EventSub
/// resolution may overwrite a dashboard one, and a dashboard resolution may never overwrite an
/// EventSub one — see <see cref="IAutomodStore.ResolveHoldAsync"/> for the exact rule and the
/// mechanism that makes the collision deterministic rather than order-dependent.
/// </para>
/// </summary>
public enum AutomodResolutionSource
{
  /// <summary>
  /// A guess, not a verdict: the 2-hour expiry sweep, or a Helix allow/deny that came back
  /// <c>gone</c> (Twitch no longer knows the hold, so it presumably aged out). Lowest precedence —
  /// any real verdict may overturn it.
  /// </summary>
  Speculative = 0,

  /// <summary>An operator allow/deny through <c>POST /api/automod/{id}/allow|deny</c> that Helix accepted.</summary>
  Dashboard = 1,

  /// <summary>Twitch's own <c>automod.message.update</c> EventSub verdict — the system of record, highest precedence.</summary>
  EventSub = 2,
}
