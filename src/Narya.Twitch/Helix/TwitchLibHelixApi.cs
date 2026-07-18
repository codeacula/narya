using Narya.Core.AppConfig;

using TwitchLib.Api;
using TwitchLib.Api.Core.Enums;
using TwitchLib.Api.Helix.Models.Channels.GetAdSchedule;
using TwitchLib.Api.Helix.Models.Channels.GetChannelInformation;
using TwitchLib.Api.Helix.Models.Channels.ModifyChannelInformation;
using TwitchLib.Api.Helix.Models.Channels.SendChatMessage;
using TwitchLib.Api.Helix.Models.Channels.StartCommercial;
using TwitchLib.Api.Helix.Models.EventSub;
using TwitchLib.Api.Helix.Models.Games;
using TwitchLib.Api.Helix.Models.Moderation.BanUser;
using TwitchLib.Api.Helix.Models.Search;
using TwitchLib.Api.Helix.Models.Streams.GetStreams;
using TwitchLib.Api.Helix.Models.Users.GetUsers;

namespace Narya.Twitch.Helix;

/// <summary>
/// <see cref="IHelixApi"/> over the real <c>TwitchAPI</c> singleton. The ONLY class that ever
/// touches <c>TwitchAPI.Settings</c>: every call first refreshes <c>Settings.ClientId</c> from
/// <see cref="IAppConfigStore"/> (cheap, idempotent — the client id can be empty at process
/// startup and set later from Settings, so it is read lazily at request time here rather than
/// once at DI-graph-build time, when an async AppConfig read isn't even possible) and then
/// delegates straight to <c>api.Helix.*</c>, passing the caller's already-resolved token as the
/// trailing per-call <c>accessToken</c> argument. Never sets <c>Settings.AccessToken</c> — every
/// call is authenticated by its own trailing token argument instead (see the Phase 2 Task 4
/// report for why mutating shared Settings state on the hot path would be a race).
/// </summary>
internal sealed class TwitchLibHelixApi(TwitchAPI api, IAppConfigStore appConfigStore) : IHelixApi
{
  public async Task<GetUsersResponse> GetUsersAsync(IReadOnlyList<string>? logins, string accessToken, CancellationToken cancellationToken)
  {
    await SyncClientIdAsync(cancellationToken).ConfigureAwait(false);
    return await api.Helix.Users.GetUsersAsync(ids: null, logins: logins?.ToList(), accessToken: accessToken).ConfigureAwait(false);
  }

  public async Task<GetChannelInformationResponse> GetChannelInformationAsync(string broadcasterId, string accessToken, CancellationToken cancellationToken)
  {
    await SyncClientIdAsync(cancellationToken).ConfigureAwait(false);
    return await api.Helix.Channels.GetChannelInformationAsync(broadcasterId, accessToken).ConfigureAwait(false);
  }

  public async Task<bool> ModifyChannelInformationAsync(string broadcasterId, ModifyChannelInformationRequest request, string accessToken, CancellationToken cancellationToken)
  {
    await SyncClientIdAsync(cancellationToken).ConfigureAwait(false);
    return await api.Helix.Channels.ModifyChannelInformationAsync(broadcasterId, request, accessToken).ConfigureAwait(false);
  }

  public async Task<GetAdScheduleResponse> GetAdScheduleAsync(string broadcasterId, string accessToken, CancellationToken cancellationToken)
  {
    await SyncClientIdAsync(cancellationToken).ConfigureAwait(false);
    return await api.Helix.Channels.GetAdScheduleAsync(broadcasterId, accessToken).ConfigureAwait(false);
  }

  public async Task<StartCommercialResponse> StartCommercialAsync(StartCommercialRequest request, string accessToken, CancellationToken cancellationToken)
  {
    await SyncClientIdAsync(cancellationToken).ConfigureAwait(false);
    return await api.Helix.Channels.StartCommercialAsync(request, accessToken).ConfigureAwait(false);
  }

  public async Task<GetStreamsResponse> GetStreamsAsync(IReadOnlyList<string> userLogins, string accessToken, CancellationToken cancellationToken)
  {
    await SyncClientIdAsync(cancellationToken).ConfigureAwait(false);
    return await api.Helix.Streams.GetStreamsAsync(userLogins: [.. userLogins], accessToken: accessToken).ConfigureAwait(false);
  }

  public async Task<SearchCategoriesResponse> SearchCategoriesAsync(string encodedQuery, string accessToken, CancellationToken cancellationToken)
  {
    await SyncClientIdAsync(cancellationToken).ConfigureAwait(false);
    return await api.Helix.Search.SearchCategoriesAsync(encodedQuery, accessToken: accessToken).ConfigureAwait(false);
  }

  public async Task<GetGamesResponse> GetGamesAsync(IReadOnlyList<string> gameIds, string accessToken, CancellationToken cancellationToken)
  {
    await SyncClientIdAsync(cancellationToken).ConfigureAwait(false);
    return await api.Helix.Games.GetGamesAsync(gameIds: [.. gameIds], accessToken: accessToken).ConfigureAwait(false);
  }

  public async Task<SendChatMessageResponse> SendChatMessageAsync(string broadcasterId, string senderId, string message, string? replyParentMessageId, string accessToken, CancellationToken cancellationToken)
  {
    await SyncClientIdAsync(cancellationToken).ConfigureAwait(false);

    // The (broadcasterId, senderId, message, replyParentMessageId, accessToken) overload is
    // marked [Obsolete] on TwitchLib.Api 3.10.2 in favor of this request-object overload — same
    // "no Async suffix" method name, just a different parameter shape.
    var request = new SendChatMessageRequest
    {
      BroadcasterId = broadcasterId,
      SenderId = senderId,
      Message = message,
      ReplyParentMessageId = replyParentMessageId,
    };
    return await api.Helix.Chat.SendChatMessage(request, accessToken).ConfigureAwait(false);
  }

  public async Task SendShoutoutAsync(string fromBroadcasterId, string toBroadcasterId, string moderatorId, string accessToken, CancellationToken cancellationToken)
  {
    await SyncClientIdAsync(cancellationToken).ConfigureAwait(false);
    await api.Helix.Chat.SendShoutoutAsync(fromBroadcasterId, toBroadcasterId, moderatorId, accessToken).ConfigureAwait(false);
  }

  public async Task SendWhisperAsync(string fromUserId, string toUserId, string message, bool newRecipient, string accessToken, CancellationToken cancellationToken)
  {
    await SyncClientIdAsync(cancellationToken).ConfigureAwait(false);
    await api.Helix.Whispers.SendWhisperAsync(fromUserId, toUserId, message, newRecipient, accessToken).ConfigureAwait(false);
  }

  public async Task<BanUserResponse> BanUserAsync(string broadcasterId, string moderatorId, BanUserRequest request, string accessToken, CancellationToken cancellationToken)
  {
    await SyncClientIdAsync(cancellationToken).ConfigureAwait(false);
    return await api.Helix.Moderation.BanUserAsync(broadcasterId, moderatorId, request, accessToken).ConfigureAwait(false);
  }

  public async Task ManageHeldAutoModMessagesAsync(string userId, string msgId, ManageHeldAutoModMessageActionEnum action, string accessToken, CancellationToken cancellationToken)
  {
    await SyncClientIdAsync(cancellationToken).ConfigureAwait(false);
    await api.Helix.Moderation.ManageHeldAutoModMessagesAsync(userId, msgId, action, accessToken).ConfigureAwait(false);
  }

  public async Task<CreateEventSubSubscriptionResponse> CreateEventSubSubscriptionAsync(
    string type, string version, Dictionary<string, string> condition, string websocketSessionId, string accessToken, CancellationToken cancellationToken)
  {
    await SyncClientIdAsync(cancellationToken).ConfigureAwait(false);
    return await api.Helix.EventSub.CreateEventSubSubscriptionAsync(
      type, version, condition, EventSubTransportMethod.Websocket, websocketSessionId: websocketSessionId, accessToken: accessToken).ConfigureAwait(false);
  }

  private async Task SyncClientIdAsync(CancellationToken cancellationToken)
  {
    var configResult = await appConfigStore.GetAsync(cancellationToken).ConfigureAwait(false);
    if (configResult.IsSuccess)
    {
      api.Settings.ClientId = configResult.Value.TwitchClientId;
    }
  }
}
