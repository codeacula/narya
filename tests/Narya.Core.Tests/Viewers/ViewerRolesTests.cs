using Narya.Core.Viewers;

namespace Narya.Core.Tests.Viewers;

public sealed class ViewerRolesTests
{
  [Fact]
  public void GetViewerRolesFromBadgesReturnsEmptyForNullBadges()
  {
    Assert.Empty(ViewerRoles.GetViewerRolesFromBadges(null));
  }

  [Fact]
  public void GetViewerRolesFromBadgesReturnsEveryMatchingRoleBroadcasterFirst()
  {
    var badges = new Dictionary<string, string>
    {
      ["subscriber"] = "12",
      ["vip"] = "1",
      ["moderator"] = "1",
      ["broadcaster"] = "1",
    };

    var roles = ViewerRoles.GetViewerRolesFromBadges(badges);

    Assert.Equal(["broadcaster", "mod", "vip", "sub"], roles);
  }

  [Fact]
  public void GetViewerRolesFromBadgesReturnsOnlyTheRolesPresent()
  {
    var badges = new Dictionary<string, string> { ["subscriber"] = "3" };

    var roles = ViewerRoles.GetViewerRolesFromBadges(badges);

    Assert.Equal(["sub"], roles);
  }

  [Fact]
  public void FallbackColorIsDeterministicForTheSameLogin()
  {
    var first = ViewerRoles.FallbackColor("codeacula");
    var second = ViewerRoles.FallbackColor("codeacula");

    Assert.Equal(first, second);
  }

  [Fact]
  public void FallbackColorReturnsAValueFromThePalette()
  {
    string[] palette = ["#ffc488", "#d7dce2", "#a8e0c4", "#9ccae8", "#bca6f0", "#f0a99d", "#f5f2e0"];

    Assert.Contains(ViewerRoles.FallbackColor("someviewer"), palette);
  }

  /// <summary>
  /// Ground-truth vector matching legacy's exact hash: sum of char codes mod 7, indexed into
  /// the palette. "ab" -> ('a' + 'b') % 7 = (97 + 98) % 7 = 195 % 7 = 6 -> palette[6].
  /// </summary>
  [Fact]
  public void FallbackColorMatchesTheLegacyHashForAKnownLogin()
  {
    Assert.Equal("#f5f2e0", ViewerRoles.FallbackColor("ab"));
  }
}
