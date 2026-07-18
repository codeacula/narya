using MediatR;

namespace Narya.Core.Sessions;

/// <summary>
/// Published for <c>stream.online</c>. Originally defined in
/// <c>Narya.Twitch.EventSub.Notifications</c> (Phase 2); moved here in Phase 3 because its
/// consumer — <c>Narya.Application.Sessions.StreamOnlineHandler</c> — lives in
/// Narya.Application, and Narya.Application deliberately does not reference Narya.Twitch (see
/// <c>Narya.Application.csproj</c>: only Narya.Core/Narya.Domain). Narya.Twitch already
/// references Narya.Core, so <c>EventSubDispatcher</c> publishing this type is unaffected by
/// the move — only its <c>using</c> changed.
/// </summary>
public sealed record StreamOnlineNotification(string StreamId, DateTimeOffset StartedAt) : INotification;

/// <summary>Published for <c>stream.offline</c>. See <see cref="StreamOnlineNotification"/>'s doc comment for why this lives here.</summary>
public sealed record StreamOfflineNotification : INotification;
