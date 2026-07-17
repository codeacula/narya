using FluentResults;

namespace Narya.Twitch.Tokens;

/// <summary>
/// Resolves the broadcaster's Twitch user id (<c>GET /helix/users</c> with the broadcaster
/// token, no query → <c>data[0].id</c>). Defined here rather than in the Helix layer so
/// <see cref="TwitchCredentials"/> can depend on the seam without a circular reference —
/// Task 4's Helix client is the real implementation; this task's tests substitute it.
/// </summary>
public interface IBroadcasterIdResolver
{
  Task<Result<string>> GetBroadcasterIdAsync(CancellationToken cancellationToken);
}
