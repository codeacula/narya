namespace Narya.Application;

/// <summary>
/// Assembly marker for Narya.Application. Not static: MediatR and FluentValidation's
/// AssemblyContaining&lt;T&gt; helpers require a type usable as a generic argument, which
/// excludes static classes (CS0718).
/// </summary>
public sealed class NaryaApplication
{
  private NaryaApplication()
  {
  }
}
