namespace Narya.Database.Common;

public interface INaryaEvent
{
  Guid EventId { get; }
  DateTimeOffset OccurredAt { get; }
}
