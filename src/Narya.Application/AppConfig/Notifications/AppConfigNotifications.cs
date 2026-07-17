using MediatR;

using Narya.Core.AppConfig;
using Narya.Core.Realtime;

namespace Narya.Application.AppConfig.Notifications;

/// <summary>
/// Published after a successful <see cref="UpdateAppConfigCommand"/>. Carries the same
/// secret-masked <see cref="AppConfigResponse"/> the command returns to its caller, so the
/// realtime bridge (Task 10) can broadcast <c>settings:updated</c> to operators without
/// re-reading the store or risking a different masking rule from the one the HTTP response
/// used.
/// </summary>
public sealed record AppConfigUpdatedNotification(AppConfigResponse Response) : INotification, IRealtimeNotification
{
  public string EventName => "settings:updated";

  public object Payload => Response;
}
