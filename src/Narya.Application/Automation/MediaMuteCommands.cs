using MediatR;

using Narya.Core.Automation;

namespace Narya.Application.Automation;

/// <summary>Fetches the current media-mute state — a port of legacy's <c>getMediaMuted</c>.</summary>
public sealed record GetMediaMuteQuery : IRequest<MediaMuteState>;

public sealed class GetMediaMuteQueryHandler(IMediaMuteStore store) : IRequestHandler<GetMediaMuteQuery, MediaMuteState>
{
  public async Task<MediaMuteState> Handle(GetMediaMuteQuery request, CancellationToken cancellationToken)
  {
    var muted = await store.GetMutedAsync(cancellationToken);
    return new MediaMuteState(muted);
  }
}

/// <summary>
/// Flips the master media-mute switch — a port of legacy's <c>setMediaMuted</c>. <see cref="Muted"/>
/// is the already-coerced strict boolean; <c>Narya.Api.Controllers.MediaMuteController</c> owns the
/// legacy-parity "<c>body.muted === true</c>, anything else is false" coercion before sending this,
/// same division of labor as every other typed command in this codebase.
/// </summary>
public sealed record SetMediaMuteCommand(bool Muted) : IRequest<MediaMuteState>;

/// <summary>
/// Persist-before-broadcast: awaits <see cref="IMediaMuteStore.SetMutedAsync"/> to completion
/// (the write has committed) before publishing <see cref="MediaMuteBroadcastNotification"/> — an
/// operator dashboard that receives the WebSocket event and immediately re-fetches
/// <c>GET /api/automation/media-mute</c> must see the same value it was just told, never a stale
/// one. Mirrors <c>UpdateAppConfigCommandHandler</c>'s store-then-publish shape exactly.
/// </summary>
public sealed class SetMediaMuteCommandHandler(IMediaMuteStore store, IMediator mediator)
  : IRequestHandler<SetMediaMuteCommand, MediaMuteState>
{
  public async Task<MediaMuteState> Handle(SetMediaMuteCommand request, CancellationToken cancellationToken)
  {
    var state = await store.SetMutedAsync(request.Muted, cancellationToken);
    await mediator.Publish(new MediaMuteBroadcastNotification(state), cancellationToken);
    return state;
  }
}
