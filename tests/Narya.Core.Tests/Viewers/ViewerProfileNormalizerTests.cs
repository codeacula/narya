using Narya.Core.Viewers;

namespace Narya.Core.Tests.Viewers;

public sealed class ViewerProfileNormalizerTests
{
  [Fact]
  public void TrimsRealNameAndNote()
  {
    var result = ViewerProfileNormalizer.Normalize("  Real Name  ", [], "  a note  ");

    Assert.Equal("Real Name", result.RealName);
    Assert.Equal("a note", result.Note);
  }

  [Fact]
  public void NullRealNameAndNoteBecomeEmptyStrings()
  {
    var result = ViewerProfileNormalizer.Normalize(null, null, null);

    Assert.Equal(string.Empty, result.RealName);
    Assert.Equal(string.Empty, result.Note);
    Assert.Empty(result.Tags);
  }

  [Fact]
  public void TagsAreTrimmedAndEmptyOnesAreDropped()
  {
    var result = ViewerProfileNormalizer.Normalize(null, ["  fan  ", "   ", "regular"], null);

    Assert.Equal(["fan", "regular"], result.Tags);
  }

  [Fact]
  public void TagsAreDeduplicatedCaseInsensitivelyKeepingTheFirstCasing()
  {
    var result = ViewerProfileNormalizer.Normalize(null, ["Fan", "fan", "FAN", "Regular"], null);

    Assert.Equal(["Fan", "Regular"], result.Tags);
  }

  [Fact]
  public void NullTagsInTheListAreSkipped()
  {
    var result = ViewerProfileNormalizer.Normalize(null, [null!, "fan"], null);

    Assert.Equal(["fan"], result.Tags);
  }
}
