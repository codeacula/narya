namespace Narya.Twitch;

/// <summary>
/// Assembly marker for Narya.Twitch. Not static: MediatR's <c>AssemblyContaining&lt;T&gt;</c>
/// helper (used by later Phase 2 tasks that register EventSub-dispatched notification
/// handlers) requires a type usable as a generic argument, which excludes static classes
/// (CS0718) — the same lesson <c>Narya.Application.NaryaApplication</c>'s marker documents.
/// </summary>
public sealed class NaryaTwitch
{
  private NaryaTwitch()
  {
  }
}
