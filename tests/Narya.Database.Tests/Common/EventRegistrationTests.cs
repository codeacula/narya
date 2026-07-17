using Marten;
using Marten.Events;

using Narya.Database.Common;

namespace Narya.Database.Tests.Common;

public sealed record ProbeEvent(Guid EventId, DateTimeOffset OccurredAt) : INaryaEvent;

public sealed class EventRegistrationTests
{
  [Fact]
  public void RegistersEveryConcreteNaryaEventInTheAssembly()
  {
    var options = new StoreOptions();
    options.Connection("Host=unused");
    options.RegisterNaryaEvents(typeof(ProbeEvent).Assembly);

    // options.Events is statically typed as the narrower IEventStoreOptions interface, which
    // does not expose AllKnownEventTypes(); the runtime instance is always the concrete
    // Marten.Events.EventGraph (public class), so cast to it to inspect the registered mappings.
    var eventGraph = (EventGraph)options.Events;
    Assert.Contains(eventGraph.AllKnownEventTypes(), m => m.EventType == typeof(ProbeEvent));
  }
}
