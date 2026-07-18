using System.Collections.Concurrent;
using System.Globalization;

using FluentResults;

using Narya.Core.AppConfig;
using Narya.Twitch.Identity;
using Narya.Twitch.Tokens;

using TwitchLib.Api.Core.Enums;
using TwitchLib.Api.Core.Exceptions;
using TwitchLib.Api.Helix.Models.Channels.ModifyChannelInformation;
using TwitchLib.Api.Helix.Models.Channels.StartCommercial;
using TwitchLib.Api.Helix.Models.Moderation.BanUser;

namespace Narya.Twitch.Helix;

/// <summary>
/// <see cref="IHelixClient"/> over <see cref="IHelixApi"/> (a thin seam over TwitchLib.Api —
/// see that interface's doc comment). Registered as a singleton: the broadcaster id, the
/// authenticated-user ids (used to resolve a chat sender's own id), and the two response caches
/// (<see cref="HelixCaches"/>) are all cached in memory across calls, which only makes sense
/// with exactly one instance — see <c>ServiceCollectionExtensions.AddNaryaTwitch</c>.
/// <see cref="HelixClient"/> is internal (not public) precisely because its constructor takes
/// the internal <see cref="IHelixApi"/> seam — the public surface is <see cref="IHelixClient"/>
/// and <see cref="IBroadcasterIdResolver"/>, both resolved through DI.
/// </summary>
internal sealed class HelixClient(
  IHelixApi helixApi,
  ITwitchCredentials credentials,
  IAppConfigStore appConfigStore,
  TimeProvider timeProvider) : IHelixClient, IBroadcasterIdResolver, ITwitchIdentityCache, IDisposable
{
  public const int DefaultTimeoutSeconds = 600;
  public const int MaxTimeoutSeconds = 1_209_600;

  /// <summary>
  /// How many times <see cref="GetBroadcasterIdAsync"/> re-resolves when an invalidation lands
  /// while its Helix round trip is in flight. Each retry needs another invalidation to race it,
  /// and invalidations are operator-driven (a config save or an OAuth reauth), so exhausting
  /// this means the identity is genuinely still churning — better to fail this call than to
  /// return, or worse cache, an id resolved against a channel the operator has already replaced.
  /// </summary>
  private const int MaxBroadcasterIdResolveAttempts = 3;

  private readonly HelixCaches _caches = new(timeProvider);
  private readonly SemaphoreSlim _broadcasterIdLock = new(1, 1);
  private readonly ConcurrentDictionary<TwitchProvider, string> _authenticatedUserIds = new();
  private readonly Lock _commercialLock = new();

  private string? _cachedBroadcasterId;

  /// <summary>
  /// Bumped by <see cref="InvalidateAsync"/>; read before and after every identity resolution so
  /// a resolution that was already in flight when the invalidation landed cannot commit its
  /// (now stale) result. See <see cref="InvalidateAsync"/> for why this exists instead of a lock.
  /// </summary>
  private int _identityGeneration;

  private Task<Result<HelixCommercialResult>>? _inFlightCommercial;

  public async Task<Result<HelixUser>> GetAuthenticatedUserAsync(TwitchProvider provider, CancellationToken cancellationToken)
  {
    var tokenResult = await credentials.GetAccessTokenAsync(provider, cancellationToken).ConfigureAwait(false);
    return tokenResult.IsFailed
      ? Result.Fail<HelixUser>(tokenResult.Errors)
      : await GetAuthenticatedUserCoreAsync(provider, tokenResult.Value, cancellationToken).ConfigureAwait(false);
  }

  public async Task<Result<string>> GetBroadcasterIdAsync(CancellationToken cancellationToken)
  {
    if (_cachedBroadcasterId is { } cached)
    {
      return Result.Ok(cached);
    }

    await _broadcasterIdLock.WaitAsync(cancellationToken).ConfigureAwait(false);
    try
    {
      for (var attempt = 1; attempt <= MaxBroadcasterIdResolveAttempts; attempt++)
      {
        // Re-check inside the lock: a concurrent caller may have already resolved it while this
        // call was waiting for the lock.
        if (_cachedBroadcasterId is { } lockedCached)
        {
          return Result.Ok(lockedCached);
        }

        // Read the generation BEFORE the config read and the Helix round trip, so an
        // InvalidateAsync that lands at any point during them is observable below.
        var generation = Volatile.Read(ref _identityGeneration);

        var resolved = await ResolveBroadcasterIdAsync(cancellationToken).ConfigureAwait(false);
        if (resolved.IsFailed)
        {
          return resolved;
        }

        if (Volatile.Read(ref _identityGeneration) == generation)
        {
          _cachedBroadcasterId = resolved.Value;
          return resolved;
        }

        // Invalidated mid-resolution: this id describes the identity the operator just replaced.
        // Neither cache nor return it — loop and resolve again against the current config.
      }

      return Result.Fail<string>("The Twitch identity changed while resolving the broadcaster id; retry.");
    }
    finally
    {
      _ = _broadcasterIdLock.Release();
    }
  }

  private async Task<Result<string>> ResolveBroadcasterIdAsync(CancellationToken cancellationToken)
  {
    var configResult = await appConfigStore.GetAsync(cancellationToken).ConfigureAwait(false);
    if (configResult.IsFailed)
    {
      return Result.Fail<string>(configResult.Errors);
    }

    if (string.IsNullOrWhiteSpace(configResult.Value.TwitchChannel))
    {
      return Result.Fail<string>("Twitch channel is not configured.");
    }

    var tokenResult = await ResolveBroadcasterOrAppAccessTokenAsync(cancellationToken).ConfigureAwait(false);
    if (tokenResult.IsFailed)
    {
      return Result.Fail<string>(tokenResult.Errors);
    }

    var usersResult = await ExecuteAsync(() =>
      helixApi.GetUsersAsync([configResult.Value.TwitchChannel], tokenResult.Value, cancellationToken)).ConfigureAwait(false);
    if (usersResult.IsFailed)
    {
      return Result.Fail<string>(usersResult.Errors);
    }

    var id = FirstOrNull(usersResult.Value.Users)?.Id;
    return string.IsNullOrEmpty(id)
      ? Result.Fail<string>($"Could not resolve the Twitch broadcaster id for \"{configResult.Value.TwitchChannel}\".")
      : Result.Ok(id);
  }

  public async Task<Result<string>> ResolveUserIdAsync(string login, CancellationToken cancellationToken)
  {
    var normalizedLogin = login.Trim().TrimStart('@').ToLowerInvariant();
    if (string.IsNullOrEmpty(normalizedLogin))
    {
      return Result.Fail<string>("Twitch login is required.");
    }

    var credentialsResult = await credentials.GetActionCredentialsAsync([], cancellationToken).ConfigureAwait(false);
    if (credentialsResult.IsFailed)
    {
      return Result.Fail<string>(credentialsResult.Errors);
    }

    // A local try/catch (rather than the shared ExecuteAsync mapper) so a Twitch 404 always
    // surfaces as "user not found" regardless of whether Twitch expresses "no such user" as an
    // empty result set or as a thrown BadResourceException — both mean the same thing here.
    try
    {
      var users = await helixApi.GetUsersAsync([normalizedLogin], credentialsResult.Value.AccessToken, cancellationToken).ConfigureAwait(false);
      var id = FirstOrNull(users.Users)?.Id;
      return string.IsNullOrEmpty(id)
        ? Result.Fail<string>($"Twitch user not found for \"{normalizedLogin}\".")
        : Result.Ok(id);
    }
    catch (OperationCanceledException)
    {
      throw;
    }
    catch (BadResourceException)
    {
      return Result.Fail<string>($"Twitch user not found for \"{normalizedLogin}\".");
    }
    catch (Exception ex)
    {
      return MapException<string>(ex);
    }
  }

  public async Task<Result<HelixChannelInfo>> GetChannelInfoAsync(CancellationToken cancellationToken)
  {
    var credentialsResult = await credentials.GetActionCredentialsAsync([], cancellationToken).ConfigureAwait(false);
    if (credentialsResult.IsFailed)
    {
      return Result.Fail<HelixChannelInfo>(credentialsResult.Errors);
    }

    var c = credentialsResult.Value;
    var result = await ExecuteAsync(() =>
      helixApi.GetChannelInformationAsync(c.BroadcasterId, c.AccessToken, cancellationToken)).ConfigureAwait(false);
    if (result.IsFailed)
    {
      return Result.Fail<HelixChannelInfo>(result.Errors);
    }

    var info = FirstOrNull(result.Value.Data);
    return info is null
      ? Result.Fail<HelixChannelInfo>("No Twitch channel information was returned.")
      : Result.Ok(new HelixChannelInfo
      {
        BroadcasterName = info.BroadcasterName ?? "",
        GameId = info.GameId ?? "",
        GameName = info.GameName ?? "",
        Title = info.Title ?? "",
        Tags = info.Tags ?? [],
      });
  }

  public async Task<Result> UpdateChannelInfoAsync(string title, string gameId, IReadOnlyList<string> tags, CancellationToken cancellationToken)
  {
    var credentialsResult = await credentials.GetActionCredentialsAsync(["channel:manage:broadcast"], cancellationToken).ConfigureAwait(false);
    if (credentialsResult.IsFailed)
    {
      return Result.Fail(credentialsResult.Errors);
    }

    var c = credentialsResult.Value;
    var request = new ModifyChannelInformationRequest { Title = title, GameId = gameId, Tags = [.. tags] };
    var result = await ExecuteAsync(() =>
      helixApi.ModifyChannelInformationAsync(c.BroadcasterId, request, c.AccessToken, cancellationToken)).ConfigureAwait(false);

    return result.IsFailed ? Result.Fail(result.Errors) : Result.Ok();
  }

  public async Task<Result<HelixStreamStatus>> GetStreamStatusAsync(CancellationToken cancellationToken)
  {
    if (_caches.TryGetStreamStatus(out var cached))
    {
      return Result.Ok(cached);
    }

    var configResult = await appConfigStore.GetAsync(cancellationToken).ConfigureAwait(false);
    if (configResult.IsFailed)
    {
      return Result.Fail<HelixStreamStatus>(configResult.Errors);
    }

    if (string.IsNullOrWhiteSpace(configResult.Value.TwitchChannel))
    {
      return Result.Fail<HelixStreamStatus>("Twitch channel is not configured.");
    }

    var tokenResult = await ResolveBroadcasterOrAppAccessTokenAsync(cancellationToken).ConfigureAwait(false);
    if (tokenResult.IsFailed)
    {
      return Result.Fail<HelixStreamStatus>(tokenResult.Errors);
    }

    var result = await ExecuteAsync(() =>
      helixApi.GetStreamsAsync([configResult.Value.TwitchChannel], tokenResult.Value, cancellationToken)).ConfigureAwait(false);
    if (result.IsFailed)
    {
      return Result.Fail<HelixStreamStatus>(result.Errors);
    }

    // An empty streams array means the channel is offline — success, not a failure.
    var stream = FirstOrNull(result.Value.Streams);
    var status = stream is null
      ? new HelixStreamStatus()
      : new HelixStreamStatus
      {
        StartedAt = new DateTimeOffset(DateTime.SpecifyKind(stream.StartedAt, DateTimeKind.Utc)),
        ViewerCount = stream.ViewerCount,
      };

    _caches.SetStreamStatus(status);
    return Result.Ok(status);
  }

  public async Task<Result<HelixAdSchedule>> GetAdScheduleAsync(CancellationToken cancellationToken)
  {
    if (_caches.TryGetAdSchedule(out var cached))
    {
      return Result.Ok(cached);
    }

    var credentialsResult = await credentials.GetActionCredentialsAsync(["channel:read:ads"], cancellationToken).ConfigureAwait(false);
    if (credentialsResult.IsFailed)
    {
      return Result.Fail<HelixAdSchedule>(credentialsResult.Errors);
    }

    var c = credentialsResult.Value;
    var result = await ExecuteAsync(() =>
      helixApi.GetAdScheduleAsync(c.BroadcasterId, c.AccessToken, cancellationToken)).ConfigureAwait(false);
    if (result.IsFailed)
    {
      return Result.Fail<HelixAdSchedule>(result.Errors);
    }

    var data = FirstOrNull(result.Value.Data);
    var schedule = data is null
      ? new HelixAdSchedule()
      : new HelixAdSchedule
      {
        NextAdAt = ParseTwitchTimestamp(data.NextAdAt),
        Duration = data.Duration,
        SnoozeCount = data.SnoozeCount,
        SnoozeRefreshAt = ParseTwitchTimestamp(data.SnoozeRefreshAt),
        PrerollFreeTime = data.PrerollFreeTime,
      };

    _caches.SetAdSchedule(schedule);
    return Result.Ok(schedule);
  }

  public async Task<Result<IReadOnlyList<HelixCategory>>> SearchCategoriesAsync(string query, CancellationToken cancellationToken)
  {
    var tokenResult = await ResolveBroadcasterOrAppAccessTokenAsync(cancellationToken).ConfigureAwait(false);
    if (tokenResult.IsFailed)
    {
      return Result.Fail<IReadOnlyList<HelixCategory>>(tokenResult.Errors);
    }

    // TwitchLib 3.10.2's SearchCategoriesAsync parameter is literally named
    // "encodedSearchQuery" — it does not encode the query for us.
    var result = await ExecuteAsync(() =>
      helixApi.SearchCategoriesAsync(Uri.EscapeDataString(query), tokenResult.Value, cancellationToken)).ConfigureAwait(false);

    return result.IsFailed
      ? Result.Fail<IReadOnlyList<HelixCategory>>(result.Errors)
      : Result.Ok<IReadOnlyList<HelixCategory>>(
        [.. (result.Value.Games ?? []).Select(g => new HelixCategory { Id = g.Id, Name = g.Name, BoxArtUrl = g.BoxArtUrl })]);
  }

  public async Task<Result<HelixCategory?>> GetGameByIdAsync(string id, CancellationToken cancellationToken)
  {
    var tokenResult = await ResolveBroadcasterOrAppAccessTokenAsync(cancellationToken).ConfigureAwait(false);
    if (tokenResult.IsFailed)
    {
      return Result.Fail<HelixCategory?>(tokenResult.Errors);
    }

    var result = await ExecuteAsync(() => helixApi.GetGamesAsync([id], tokenResult.Value, cancellationToken)).ConfigureAwait(false);
    if (result.IsFailed)
    {
      return Result.Fail<HelixCategory?>(result.Errors);
    }

    var game = FirstOrNull(result.Value.Data);
    return Result.Ok(game is null ? null : new HelixCategory { Id = game.Id, Name = game.Name, BoxArtUrl = game.BoxArtUrl });
  }

  public Task<Result<HelixCommercialResult>> RunCommercialAsync(int lengthSeconds = 180, CancellationToken cancellationToken = default)
  {
    lock (_commercialLock)
    {
      // A prior call's Task is only considered "in flight" while its OWN async method body —
      // including its finally block, below — hasn't finished; that finally block clears this
      // field under the same lock before the Task actually transitions to IsCompleted, so a
      // concurrent caller can never observe IsCompleted==true while the field still points at
      // it. Concurrent callers sharing this Task also share whichever CancellationToken
      // started it — a deliberate tradeoff of single-flight dedup, matching legacy's
      // WeakMap-based in-flight promise.
      if (_inFlightCommercial is { IsCompleted: false } inFlight)
      {
        return inFlight;
      }

      var task = RunCommercialCoreAsync(lengthSeconds, cancellationToken);
      _inFlightCommercial = task;
      return task;
    }
  }

  private async Task<Result<HelixCommercialResult>> RunCommercialCoreAsync(int lengthSeconds, CancellationToken cancellationToken)
  {
    try
    {
      var credentialsResult = await credentials.GetActionCredentialsAsync(["channel:edit:commercial"], cancellationToken).ConfigureAwait(false);
      if (credentialsResult.IsFailed)
      {
        return Result.Fail<HelixCommercialResult>(credentialsResult.Errors);
      }

      var c = credentialsResult.Value;
      var request = new StartCommercialRequest { BroadcasterId = c.BroadcasterId, Length = lengthSeconds };
      var result = await ExecuteAsync(() =>
        helixApi.StartCommercialAsync(request, c.AccessToken, cancellationToken)).ConfigureAwait(false);

      // Unlike most other Helix responses, TwitchLib's StartCommercialResponse is NOT wrapped
      // in a Data[] array — Length/Message/RetryAfter sit directly on the response.
      return result.IsFailed
        ? Result.Fail<HelixCommercialResult>(result.Errors)
        : Result.Ok(new HelixCommercialResult { Length = result.Value.Length, Message = result.Value.Message, RetryAfter = result.Value.RetryAfter });
    }
    finally
    {
      lock (_commercialLock)
      {
        _inFlightCommercial = null;
      }
    }
  }

  public async Task<Result<string>> SendChatMessageAsync(
    TwitchProvider sender, string message, string? replyParentMessageId = null, CancellationToken cancellationToken = default)
  {
    var trimmed = message.Trim();
    if (string.IsNullOrEmpty(trimmed))
    {
      return Result.Fail<string>("Message is required.");
    }

    var resolvedResult = sender == TwitchProvider.Broadcaster
      ? await ResolveBroadcasterChatSenderAsync(cancellationToken).ConfigureAwait(false)
      : await ResolveBotChatSenderAsync(cancellationToken).ConfigureAwait(false);
    if (resolvedResult.IsFailed)
    {
      return Result.Fail<string>(resolvedResult.Errors);
    }

    var (accessToken, broadcasterId, senderId) = resolvedResult.Value;
    var result = await ExecuteAsync(() =>
      helixApi.SendChatMessageAsync(broadcasterId, senderId, trimmed, replyParentMessageId, accessToken, cancellationToken)).ConfigureAwait(false);
    if (result.IsFailed)
    {
      return Result.Fail<string>(result.Errors);
    }

    // A drop is a normal (HTTP 200) response with IsSent==false / a DropReason present — not a
    // thrown exception, so it is handled here rather than in ExecuteAsync's catch clauses.
    var sent = FirstOrNull(result.Value.Data);
    return sent switch
    {
      null => Result.Fail<string>("Twitch did not return a chat message result."),
      { IsSent: false } or { DropReason: not null } => Result.Fail<string>(sent.DropReason?.Message ?? "Twitch did not send the message."),
      _ => Result.Ok(sent.MessageId ?? ""),
    };
  }

  public async Task<Result> SendShoutoutAsync(string toBroadcasterId, CancellationToken cancellationToken)
  {
    var credentialsResult = await credentials.GetActionCredentialsAsync(["moderator:manage:shoutouts"], cancellationToken).ConfigureAwait(false);
    if (credentialsResult.IsFailed)
    {
      return Result.Fail(credentialsResult.Errors);
    }

    var c = credentialsResult.Value;
    // moderator_id is the broadcaster's own id — this call always uses the broadcaster's own
    // token, so the acting moderator IS the broadcaster.
    return await ExecuteVoidAsync(() =>
      helixApi.SendShoutoutAsync(c.BroadcasterId, toBroadcasterId, c.BroadcasterId, c.AccessToken, cancellationToken)).ConfigureAwait(false);
  }

  public async Task<Result> SendWhisperAsync(string toUserId, string message, CancellationToken cancellationToken)
  {
    var trimmed = message.Trim();
    if (string.IsNullOrEmpty(trimmed))
    {
      return Result.Fail("Whisper message is required.");
    }

    if (trimmed.Length > 500)
    {
      trimmed = trimmed[..500];
    }

    var credentialsResult = await credentials.GetActionCredentialsAsync(["user:manage:whispers"], cancellationToken).ConfigureAwait(false);
    if (credentialsResult.IsFailed)
    {
      return Result.Fail(credentialsResult.Errors);
    }

    var c = credentialsResult.Value;
    // from_user_id is the broadcaster's own id, for the same reason as the shoutout's
    // moderator_id above. newRecipient=true is always safe — see IHelixApi.SendWhisperAsync.
    return await ExecuteVoidAsync(() =>
      helixApi.SendWhisperAsync(c.BroadcasterId, toUserId, trimmed, newRecipient: true, c.AccessToken, cancellationToken)).ConfigureAwait(false);
  }

  public async Task<Result> BanOrTimeoutAsync(string userId, int? durationSeconds, string? reason, CancellationToken cancellationToken)
  {
    var credentialsResult = await credentials.GetActionCredentialsAsync(["moderator:manage:banned_users"], cancellationToken).ConfigureAwait(false);
    if (credentialsResult.IsFailed)
    {
      return Result.Fail(credentialsResult.Errors);
    }

    var c = credentialsResult.Value;
    int? duration = durationSeconds is int requested
      ? Math.Clamp(requested <= 0 ? DefaultTimeoutSeconds : requested, 1, MaxTimeoutSeconds)
      : null;

    var trimmedReason = string.IsNullOrWhiteSpace(reason) ? null : reason.Trim();
    if (trimmedReason is { Length: > 500 })
    {
      trimmedReason = trimmedReason[..500];
    }

    var request = new BanUserRequest { UserId = userId, Duration = duration, Reason = trimmedReason };
    var result = await ExecuteAsync(() =>
      helixApi.BanUserAsync(c.BroadcasterId, c.BroadcasterId, request, c.AccessToken, cancellationToken)).ConfigureAwait(false);

    return result.IsFailed ? Result.Fail(result.Errors) : Result.Ok();
  }

  public async Task<Result<AutomodResolution>> ResolveAutomodMessageAsync(string messageId, bool allow, CancellationToken cancellationToken)
  {
    var credentialsResult = await credentials.GetActionCredentialsAsync(["moderator:manage:automod"], cancellationToken).ConfigureAwait(false);
    if (credentialsResult.IsFailed)
    {
      return Result.Fail<AutomodResolution>(credentialsResult.Errors);
    }

    var c = credentialsResult.Value;
    var action = allow ? ManageHeldAutoModMessageActionEnum.ALLOW : ManageHeldAutoModMessageActionEnum.DENY;

    // A local try/catch (rather than the shared ExecuteAsync mapper): here — and only here — a
    // 404 is a successful outcome (the hold is already gone), not a failure.
    try
    {
      await helixApi.ManageHeldAutoModMessagesAsync(c.BroadcasterId, messageId, action, c.AccessToken, cancellationToken).ConfigureAwait(false);
      return Result.Ok(new AutomodResolution { Outcome = AutomodOutcomes.Ok });
    }
    catch (OperationCanceledException)
    {
      throw;
    }
    catch (BadResourceException)
    {
      return Result.Ok(new AutomodResolution { Outcome = AutomodOutcomes.Gone });
    }
    catch (Exception ex)
    {
      return MapException<AutomodResolution>(ex);
    }
  }

  public async Task<Result> CreateEventSubWebsocketSubscriptionAsync(
    string type, string version, IReadOnlyDictionary<string, string> condition, string sessionId, CancellationToken cancellationToken)
  {
    // A FRESH token every call, deliberately not routed through the cached
    // ResolveBroadcasterOrAppAccessTokenAsync/GetActionCredentialsAsync helpers above — see
    // this method's doc comment on IHelixClient for why subscription creation specifically
    // cannot rely on anything cached surviving a Twitch Client ID rotation.
    var tokenResult = await credentials.GetAccessTokenAsync(TwitchProvider.Broadcaster, cancellationToken).ConfigureAwait(false);
    if (tokenResult.IsFailed)
    {
      return Result.Fail(tokenResult.Errors);
    }

    // TwitchLib.Api's CreateEventSubSubscriptionAsync requires a concrete Dictionary; every
    // EventSubSubscription.ConditionFor delegate already returns one, so this only allocates a
    // copy for a caller that passed some other IReadOnlyDictionary implementation.
    var conditionDictionary = condition as Dictionary<string, string> ?? new Dictionary<string, string>(condition);

    var result = await ExecuteAsync(() =>
      helixApi.CreateEventSubSubscriptionAsync(type, version, conditionDictionary, sessionId, tokenResult.Value, cancellationToken)).ConfigureAwait(false);

    return result.IsFailed ? Result.Fail(result.Errors) : Result.Ok();
  }

  /// <summary>
  /// Drops everything this client caches ABOUT a particular Twitch identity: the resolved
  /// broadcaster id (so the very next <see cref="GetBroadcasterIdAsync"/> re-reads
  /// <c>TwitchChannel</c> from config and re-resolves against Helix), the per-provider
  /// authenticated-user ids (a bot reauth can point <see cref="TwitchProvider.Bot"/> at a
  /// different account entirely), and the two short-TTL response caches, which describe the
  /// OLD broadcaster's stream.
  ///
  /// Deliberately not taking <see cref="_broadcasterIdLock"/>: a concurrent
  /// <see cref="GetBroadcasterIdAsync"/> already holding that lock is mid-resolution against
  /// the config it read, and blocking here to overwrite its result would only serialize this
  /// call behind a Helix round trip. Clearing the fields alone would NOT be safe — a resolution
  /// that was already awaiting Helix when this ran would write the OLD broadcaster id back into
  /// an empty cache, permanently, since <see cref="GetBroadcasterIdAsync"/> returns early on any
  /// non-null cache and nothing else ever clears it. Bumping <see cref="_identityGeneration"/>
  /// closes that window: every resolution snapshots the generation before its round trip and
  /// discards its result if this ran in the meantime.
  /// </summary>
  public Task InvalidateAsync(CancellationToken cancellationToken)
  {
    // Clear FIRST, bump LAST. The Interlocked increment is the only write here with release
    // semantics, so it is what PUBLISHES the clears below to a resolution running on another
    // core; bumping first would leave the null write to the plain _cachedBroadcasterId field
    // unordered with respect to it — unobservable on x86-64's strong memory model, genuinely
    // reachable on ARM64, where a reader could observe the new generation while still reading
    // the OLD cached broadcaster id.
    //
    // The direction that matters is unchanged: a resolution that starts in the window between
    // the clears and the bump snapshots the OLD generation, re-reads config (the cache is
    // already empty), and then discards its own fresh result when it finds the generation
    // moved — an over-clear costing one extra resolution. It can still never over-CACHE a
    // stale identity, which is the invariant _identityGeneration exists to hold.
    _cachedBroadcasterId = null;
    _authenticatedUserIds.Clear();
    _caches.Clear();
    _ = Interlocked.Increment(ref _identityGeneration);
    return Task.CompletedTask;
  }

  /// <summary>Releases <see cref="_broadcasterIdLock"/>. HelixClient is a singleton, so this only runs once, at host shutdown.</summary>
  public void Dispose() => _broadcasterIdLock.Dispose();

  private async Task<Result<(string AccessToken, string BroadcasterId, string SenderId)>> ResolveBroadcasterChatSenderAsync(CancellationToken cancellationToken)
  {
    var credentialsResult = await credentials.GetActionCredentialsAsync(["user:write:chat"], cancellationToken).ConfigureAwait(false);
    if (credentialsResult.IsFailed)
    {
      return Result.Fail<(string, string, string)>(credentialsResult.Errors);
    }

    var c = credentialsResult.Value;
    // The broadcaster's own token authenticates as the broadcaster, so the sender IS the broadcaster id.
    return Result.Ok((c.AccessToken, c.BroadcasterId, c.BroadcasterId));
  }

  private async Task<Result<(string AccessToken, string BroadcasterId, string SenderId)>> ResolveBotChatSenderAsync(CancellationToken cancellationToken)
  {
    var tokenResult = await credentials.GetAccessTokenAsync(TwitchProvider.Bot, cancellationToken).ConfigureAwait(false);
    if (tokenResult.IsFailed)
    {
      return Result.Fail<(string, string, string)>(tokenResult.Errors);
    }

    var broadcasterIdResult = await GetBroadcasterIdAsync(cancellationToken).ConfigureAwait(false);
    if (broadcasterIdResult.IsFailed)
    {
      return Result.Fail<(string, string, string)>(broadcasterIdResult.Errors);
    }

    var senderIdResult = await ResolveCachedAuthenticatedUserIdAsync(TwitchProvider.Bot, tokenResult.Value, cancellationToken).ConfigureAwait(false);
    return senderIdResult.IsFailed
      ? Result.Fail<(string, string, string)>(senderIdResult.Errors)
      : Result.Ok((tokenResult.Value, broadcasterIdResult.Value, senderIdResult.Value));
  }

  private async Task<Result<string>> ResolveCachedAuthenticatedUserIdAsync(TwitchProvider provider, string accessToken, CancellationToken cancellationToken)
  {
    if (_authenticatedUserIds.TryGetValue(provider, out var cachedId))
    {
      return Result.Ok(cachedId);
    }

    // Same in-flight window as GetBroadcasterIdAsync, and the same fix: a reauth that lands
    // while this round trip is outstanding must not have the PREVIOUS account's user id written
    // back into the just-cleared dictionary, where nothing would ever evict it again.
    var generation = Volatile.Read(ref _identityGeneration);

    var userResult = await GetAuthenticatedUserCoreAsync(provider, accessToken, cancellationToken).ConfigureAwait(false);
    if (userResult.IsFailed)
    {
      return Result.Fail<string>(userResult.Errors);
    }

    if (Volatile.Read(ref _identityGeneration) == generation)
    {
      _authenticatedUserIds[provider] = userResult.Value.Id;
    }

    return Result.Ok(userResult.Value.Id);
  }

  private async Task<Result<HelixUser>> GetAuthenticatedUserCoreAsync(TwitchProvider provider, string accessToken, CancellationToken cancellationToken)
  {
    var result = await ExecuteAsync(() => helixApi.GetUsersAsync(null, accessToken, cancellationToken)).ConfigureAwait(false);
    if (result.IsFailed)
    {
      return Result.Fail<HelixUser>(result.Errors);
    }

    var user = FirstOrNull(result.Value.Users);
    return user is null
      ? Result.Fail<HelixUser>($"Could not resolve the authenticated Twitch {provider} user.")
      : Result.Ok(new HelixUser { Id = user.Id, Login = user.Login });
  }

  /// <summary>
  /// The token resolution legacy's <c>getTwitchApiHeaders</c> uses for reads that don't need
  /// broadcaster-specific scopes: the broadcaster's own token if one is connected and fresh,
  /// otherwise the app (client_credentials) token.
  /// </summary>
  private async Task<Result<string>> ResolveBroadcasterOrAppAccessTokenAsync(CancellationToken cancellationToken)
  {
    var broadcasterToken = await credentials.GetAccessTokenAsync(TwitchProvider.Broadcaster, cancellationToken).ConfigureAwait(false);
    if (broadcasterToken.IsSuccess)
    {
      return broadcasterToken;
    }

    var appToken = await credentials.GetAppAccessTokenAsync(cancellationToken).ConfigureAwait(false);
    return appToken.IsSuccess ? appToken : Result.Fail<string>("Twitch is not authenticated and no app access token is available.");
  }

  /// <summary>
  /// Twitch's ad-schedule timestamps arrive from TwitchLib as raw RFC3339 strings (or an empty
  /// string when nothing is scheduled) rather than parsed dates — see <see cref="HelixAdSchedule"/>.
  /// </summary>
  private static DateTimeOffset? ParseTwitchTimestamp(string? value) =>
    !string.IsNullOrEmpty(value) &&
    DateTimeOffset.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var parsed)
      ? parsed
      : null;

  /// <summary>
  /// The shared TwitchLib → FluentResults error mapping (twitchlib-spec.md §2.4): a broad catch
  /// around every <see cref="IHelixApi"/> call, ordered most-specific-first. Never swallows
  /// <see cref="OperationCanceledException"/>.
  /// </summary>
  private static async Task<Result<T>> ExecuteAsync<T>(Func<Task<T>> operation)
  {
    try
    {
      return Result.Ok(await operation().ConfigureAwait(false));
    }
    catch (OperationCanceledException)
    {
      throw;
    }
    catch (Exception ex)
    {
      return MapException<T>(ex);
    }
  }

  private static async Task<Result> ExecuteVoidAsync(Func<Task> operation)
  {
    var wrapped = await ExecuteAsync(async () =>
    {
      await operation().ConfigureAwait(false);
      return true;
    }).ConfigureAwait(false);

    return wrapped.IsFailed ? Result.Fail(wrapped.Errors) : Result.Ok();
  }

  private static Result<T> MapException<T>(Exception ex) => ex switch
  {
    TooManyRequestsException => Result.Fail<T>($"Twitch is rate-limiting Helix requests; back off and retry. ({ex.Message})"),
    TokenExpiredException or BadTokenException or BadScopeException =>
      Result.Fail<T>($"The Twitch token is no longer valid; reconnect Twitch. ({ex.Message})"),
    BadResourceException => Result.Fail<T>($"Twitch could not find the requested resource. ({ex.Message})"),
    _ => Result.Fail<T>(ex.Message),
  };

  /// <summary>Every Helix response's <c>data</c> array holds at most one element for the lookups this client makes — an indexer check (CA1826) instead of LINQ's <c>FirstOrDefault()</c>.</summary>
  private static T? FirstOrNull<T>(IReadOnlyList<T>? items) where T : class =>
    items is { Count: > 0 } ? items[0] : null;
}
