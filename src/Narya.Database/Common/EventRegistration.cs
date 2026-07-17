using System.Reflection;

using Marten;

namespace Narya.Database.Common;

public static class EventRegistration
{
  public static void RegisterNaryaEvents(this StoreOptions options, Assembly assembly)
  {
    var eventTypes = assembly.GetTypes()
      .Where(t => t is { IsClass: true, IsAbstract: false } && t.IsAssignableTo(typeof(INaryaEvent)));
    foreach (var type in eventTypes)
    {
      options.Events.AddEventType(type);
    }
  }
}
