using Narya.Twitch.EventSub;

namespace Narya.Twitch.Tests.EventSub;

/// <summary>
/// Exercises the two pure decision points <see cref="TwitchEventSubService"/> factors out of
/// the (un-fakeable) socket lifecycle specifically so they can be tested without one:
/// <see cref="TwitchEventSubService.ShouldResubscribe"/> (re-subscribe only when the session
/// actually changed) and <see cref="TwitchEventSubService.BackoffDelays"/> (the hard-drop
/// reconnect loop's exponential-backoff sequence — twitchlib-spec.md §3, "NEVER the README's
/// tight retry loop").
/// </summary>
public sealed class TwitchEventSubDecisionTests
{
  [Fact]
  public void ShouldResubscribeIsFalseWhenTheSessionIdIsUnchanged()
  {
    Assert.False(TwitchEventSubService.ShouldResubscribe("session-1", "session-1"));
  }

  [Fact]
  public void ShouldResubscribeIsTrueWhenTheSessionIdChanges()
  {
    Assert.True(TwitchEventSubService.ShouldResubscribe("session-1", "session-2"));
  }

  [Fact]
  public void ShouldResubscribeIsTrueWhenThereWasNoPreviousSession()
  {
    Assert.True(TwitchEventSubService.ShouldResubscribe(previousSessionId: null, newSessionId: "session-1"));
  }

  [Fact]
  public void ShouldResubscribeIsOrdinalNotCaseInsensitive()
  {
    // Twitch session ids are opaque tokens, not case-insensitive identifiers. This does not
    // model a real Twitch scenario (Twitch never reuses an id with different casing) — it
    // pins the comparison itself to ordinal so a future edit cannot silently switch it to a
    // culture- or case-insensitive comparer.
    Assert.True(TwitchEventSubService.ShouldResubscribe("Session-1", "session-1"));
  }

  [Fact]
  public void BackoffDelaysStartsAtTheInitialDelay()
  {
    Assert.Equal(TwitchEventSubService.InitialBackoffDelay, TwitchEventSubService.BackoffDelays().First());
  }

  [Fact]
  public void BackoffDelaysIsMonotonicallyNonDecreasing()
  {
    var delays = TwitchEventSubService.BackoffDelays().Take(25).ToArray();

    for (var i = 1; i < delays.Length; i++)
    {
      Assert.True(
        delays[i] >= delays[i - 1],
        $"Delay at index {i} ({delays[i]}) was smaller than the previous delay ({delays[i - 1]}).");
    }
  }

  [Fact]
  public void BackoffDelaysDoublesEachStepUntilCapped()
  {
    var delays = TwitchEventSubService.BackoffDelays()
      .TakeWhile(delay => delay < TwitchEventSubService.MaxBackoffDelay)
      .Take(10)
      .ToArray();

    // At least one doubling step exists between the initial delay and the cap — otherwise
    // this assertion would vacuously pass over an empty sequence.
    Assert.NotEmpty(delays);

    for (var i = 1; i < delays.Length; i++)
    {
      Assert.Equal(delays[i - 1] * 2, delays[i]);
    }
  }

  [Fact]
  public void BackoffDelaysNeverExceedsTheCap()
  {
    Assert.All(
      TwitchEventSubService.BackoffDelays().Take(50),
      delay => Assert.True(delay <= TwitchEventSubService.MaxBackoffDelay));
  }

  [Fact]
  public void BackoffDelaysReachesAndHoldsTheCap()
  {
    var delays = TwitchEventSubService.BackoffDelays().Take(50).ToArray();

    Assert.Contains(TwitchEventSubService.MaxBackoffDelay, delays);
    // Once capped, it stays capped — never resets or oscillates back down.
    Assert.All(delays.SkipWhile(delay => delay < TwitchEventSubService.MaxBackoffDelay), delay => Assert.Equal(TwitchEventSubService.MaxBackoffDelay, delay));
  }
}
