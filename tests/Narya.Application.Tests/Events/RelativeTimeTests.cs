using Narya.Application.Events;

namespace Narya.Application.Tests.Events;

/// <summary>Ports legacy's <c>formatAgo</c> test coverage (<c>legacy/src/server/dashboard/status.ts</c>) — boundary-exact.</summary>
public sealed class RelativeTimeTests
{
  private static readonly DateTimeOffset Now = DateTimeOffset.Parse("2026-07-17T12:00:00Z", System.Globalization.CultureInfo.InvariantCulture);

  [Fact]
  public void UnderAMinuteIsJustNow()
  {
    Assert.Equal("just now", RelativeTime.FormatAgo(Now.AddSeconds(-30), Now));
  }

  [Fact]
  public void ExactlyZeroSecondsIsJustNow()
  {
    Assert.Equal("just now", RelativeTime.FormatAgo(Now, Now));
  }

  [Fact]
  public void AFutureTimestampClampsToJustNowRatherThanGoingNegative()
  {
    Assert.Equal("just now", RelativeTime.FormatAgo(Now.AddSeconds(10), Now));
  }

  [Fact]
  public void UnderAnHourIsMinutesColonSeconds()
  {
    Assert.Equal("5:07", RelativeTime.FormatAgo(Now.AddMinutes(-5).AddSeconds(-7), Now));
  }

  [Fact]
  public void UnderAnHourPadsSecondsToTwoDigits()
  {
    Assert.Equal("1:05", RelativeTime.FormatAgo(Now.AddMinutes(-1).AddSeconds(-5), Now));
  }

  [Fact]
  public void UnderADayIsHoursAndMinutes()
  {
    Assert.Equal("2h 30m", RelativeTime.FormatAgo(Now.AddHours(-2).AddMinutes(-30), Now));
  }

  [Fact]
  public void UnderThirtyDaysIsDaysAgo()
  {
    Assert.Equal("3d ago", RelativeTime.FormatAgo(Now.AddDays(-3), Now));
  }

  [Fact]
  public void ThirtyDaysOrMoreIsMonthsAgo()
  {
    Assert.Equal("2mo ago", RelativeTime.FormatAgo(Now.AddDays(-60), Now));
  }
}
