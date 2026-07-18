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

// The second attribute is required for NSubstitute to fake this internal interface: Castle's
// dynamic-proxy library (which NSubstitute is built on) generates the fake into an assembly
// named "DynamicProxyGenAssembly2" — without granting IT visibility too, Substitute.For<IHelixApi>()
// throws at runtime ("Can not create proxy... because it is not accessible"), even though
// Narya.Twitch.Tests itself can already see internal members via the first attribute.
[assembly: System.Runtime.CompilerServices.InternalsVisibleTo("Narya.Twitch.Tests")]
[assembly: System.Runtime.CompilerServices.InternalsVisibleTo("DynamicProxyGenAssembly2")]

namespace Narya.Twitch.Helix;

/// <summary>
/// The ~13 TwitchLib.Api Helix methods <see cref="HelixClient"/> calls, isolated behind an
/// internal seam so tests substitute this interface directly — including making it THROW the
/// real TwitchLib exception types (they're public, in <c>TwitchLib.Api.Core.Exceptions</c>) —
/// instead of needing to fake TwitchLib's own <c>TwitchAPI</c>/<c>Helix</c> object graph, which
/// has no seam of its own (its Helix category classes are not interfaces).
///
/// Every method takes an already-resolved access token (it never resolves one itself, and
/// never touches <c>ITwitchCredentials</c>) and returns TwitchLib's own response type verbatim
/// — <see cref="HelixClient"/> maps those into <c>HelixModels.cs</c> records so no TwitchLib
/// type ever crosses <see cref="IHelixClient"/>. <see cref="TwitchLibHelixApi"/> is the only
/// production implementation and the only class that touches the shared <c>TwitchAPI</c>
/// singleton.
/// </summary>
internal interface IHelixApi
{
  /// <summary><paramref name="logins"/> null → self-lookup (<c>GET /users</c> with no query, resolved via <paramref name="accessToken"/>'s own identity).</summary>
  Task<GetUsersResponse> GetUsersAsync(IReadOnlyList<string>? logins, string accessToken, CancellationToken cancellationToken);

  Task<GetChannelInformationResponse> GetChannelInformationAsync(string broadcasterId, string accessToken, CancellationToken cancellationToken);

  /// <summary>TwitchLib returns <see cref="Task{Boolean}"/> here (not <c>Task</c>) — a failed update THROWS rather than returning <see langword="false"/>; a successful one always returns <see langword="true"/>.</summary>
  Task<bool> ModifyChannelInformationAsync(string broadcasterId, ModifyChannelInformationRequest request, string accessToken, CancellationToken cancellationToken);

  Task<GetAdScheduleResponse> GetAdScheduleAsync(string broadcasterId, string accessToken, CancellationToken cancellationToken);

  Task<StartCommercialResponse> StartCommercialAsync(StartCommercialRequest request, string accessToken, CancellationToken cancellationToken);

  Task<GetStreamsResponse> GetStreamsAsync(IReadOnlyList<string> userLogins, string accessToken, CancellationToken cancellationToken);

  /// <summary><paramref name="encodedQuery"/> must already be URL-encoded — on TwitchLib.Api 3.10.2 the parameter is literally named <c>encodedSearchQuery</c>; TwitchLib does not encode it for us.</summary>
  Task<SearchCategoriesResponse> SearchCategoriesAsync(string encodedQuery, string accessToken, CancellationToken cancellationToken);

  Task<GetGamesResponse> GetGamesAsync(IReadOnlyList<string> gameIds, string accessToken, CancellationToken cancellationToken);

  Task<SendChatMessageResponse> SendChatMessageAsync(string broadcasterId, string senderId, string message, string? replyParentMessageId, string accessToken, CancellationToken cancellationToken);

  Task SendShoutoutAsync(string fromBroadcasterId, string toBroadcasterId, string moderatorId, string accessToken, CancellationToken cancellationToken);

  /// <summary><paramref name="newRecipient"/> is a required TwitchLib parameter with no default — <see cref="HelixClient"/> always passes <see langword="true"/> (Twitch only uses it to decide whether to show a "message request" prompt; passing <see langword="true"/> for a returning recipient is a no-op, not an error).</summary>
  Task SendWhisperAsync(string fromUserId, string toUserId, string message, bool newRecipient, string accessToken, CancellationToken cancellationToken);

  Task<BanUserResponse> BanUserAsync(string broadcasterId, string moderatorId, BanUserRequest request, string accessToken, CancellationToken cancellationToken);

  Task ManageHeldAutoModMessagesAsync(string userId, string msgId, ManageHeldAutoModMessageActionEnum action, string accessToken, CancellationToken cancellationToken);

  /// <summary>
  /// Creates a single EventSub subscription over an existing websocket session
  /// (<c>transport.method = websocket</c> is hard-coded by <see cref="TwitchLibHelixApi"/> —
  /// this seam has no webhook/conduit callers). <paramref name="condition"/> is a concrete
  /// <see cref="Dictionary{TKey,TValue}"/> rather than <c>IReadOnlyDictionary</c> because that
  /// is the exact type TwitchLib.Api's own <c>CreateEventSubSubscriptionAsync</c> requires.
  /// </summary>
  Task<CreateEventSubSubscriptionResponse> CreateEventSubSubscriptionAsync(
    string type, string version, Dictionary<string, string> condition, string websocketSessionId, string accessToken, CancellationToken cancellationToken);
}
