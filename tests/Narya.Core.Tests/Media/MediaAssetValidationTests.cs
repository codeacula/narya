using Narya.Core.Media;

namespace Narya.Core.Tests.Media;

/// <summary>
/// Pure unit tests for <see cref="MediaAssetValidation.Normalize"/> — a port of legacy's
/// <c>normalize</c>/<c>validateLocal</c>/<c>validateRemote</c> test coverage
/// (<c>legacy/src/server/mediaAssets.ts:122-153</c>). No document store involved; a hand-rolled
/// <see cref="FakeMediaFileCatalog"/> stands in for <see cref="IMediaFileCatalog"/>, mirroring
/// <c>Narya.Database.Tests.Automod.AutomodStoreTests</c>'s hand-rolled <c>ManualTimeProvider</c>
/// rather than pulling in a mocking library this project doesn't otherwise reference.
/// </summary>
public sealed class MediaAssetValidationTests
{
  private sealed class FakeMediaFileCatalog : IMediaFileCatalog
  {
    private readonly Dictionary<string, MediaKind> _files = new(StringComparer.Ordinal);

    public void AddFile(string src, MediaKind kind) => _files[src] = kind;

    public bool IsAvailable(MediaSourceType sourceType, string src) =>
      sourceType == MediaSourceType.Remote || _files.ContainsKey(src);

    public MediaKind? KindForLocalSrc(string src) => _files.TryGetValue(src, out var kind) ? kind : null;

    public IReadOnlyList<MediaFile> Discovered() => [];
  }

  private static MediaAsset BuildAsset(
    Guid? id = null,
    string label = "Quack",
    MediaKind kind = MediaKind.Audio,
    MediaSourceType sourceType = MediaSourceType.Local,
    string src = "/sounds/quack.mp3",
    double volume = 0.5,
    bool enabled = true,
    bool available = true) => new(
      Id: id ?? Guid.NewGuid(),
      Label: label,
      Kind: kind,
      SourceType: sourceType,
      Src: src,
      Volume: volume,
      Enabled: enabled,
      Available: available,
      CreatedAt: DateTimeOffset.UtcNow,
      UpdatedAt: DateTimeOffset.UtcNow);

  // ---------------------------------------------------------------------------------------
  // Label
  // ---------------------------------------------------------------------------------------

  [Fact]
  public void EmptyLabelFails()
  {
    var catalog = new FakeMediaFileCatalog();
    catalog.AddFile("https://example.com/x", MediaKind.Audio);
    var patch = new MediaAssetPatch { Label = "   ", SourceType = MediaSourceType.Remote, Src = "https://example.com/x.mp3", Kind = MediaKind.Audio };

    var result = MediaAssetValidation.Normalize(patch, null, catalog);

    Assert.True(result.IsFailed);
    Assert.Contains(result.Errors, e => e.Message == "A label is required.");
  }

  [Fact]
  public void LabelIsTrimmed()
  {
    var catalog = new FakeMediaFileCatalog();
    var patch = new MediaAssetPatch
    {
      Label = "  Quack  ",
      SourceType = MediaSourceType.Remote,
      Src = "https://example.com/x.mp3",
      Kind = MediaKind.Audio,
    };

    var result = MediaAssetValidation.Normalize(patch, null, catalog);

    Assert.True(result.IsSuccess);
    Assert.Equal("Quack", result.Value.Label);
  }

  [Fact]
  public void LabelOverMaxLengthFails()
  {
    var catalog = new FakeMediaFileCatalog();
    var patch = new MediaAssetPatch
    {
      Label = new string('a', MediaAssetValidation.MaxLabelLength + 1),
      SourceType = MediaSourceType.Remote,
      Src = "https://example.com/x.mp3",
      Kind = MediaKind.Audio,
    };

    var result = MediaAssetValidation.Normalize(patch, null, catalog);

    Assert.True(result.IsFailed);
  }

  // ---------------------------------------------------------------------------------------
  // Remote validation
  // ---------------------------------------------------------------------------------------

  [Fact]
  public void RemoteNonUrlFails()
  {
    var catalog = new FakeMediaFileCatalog();
    var patch = new MediaAssetPatch
    {
      Label = "Quack",
      SourceType = MediaSourceType.Remote,
      Src = "not-a-url",
      Kind = MediaKind.Audio,
    };

    var result = MediaAssetValidation.Normalize(patch, null, catalog);

    Assert.True(result.IsFailed);
    Assert.Contains(result.Errors, e => e.Message == "not-a-url is not a valid URL.");
  }

  [Fact]
  public void RemoteNonHttpSchemeFails()
  {
    var catalog = new FakeMediaFileCatalog();
    var patch = new MediaAssetPatch
    {
      Label = "Quack",
      SourceType = MediaSourceType.Remote,
      Src = "ftp://example.com/x.mp3",
      Kind = MediaKind.Audio,
    };

    var result = MediaAssetValidation.Normalize(patch, null, catalog);

    Assert.True(result.IsFailed);
    Assert.Contains(result.Errors, e => e.Message == "A remote source must be an http:// or https:// URL.");
  }

  [Fact]
  public void RemoteHttpsUrlSucceeds()
  {
    var catalog = new FakeMediaFileCatalog();
    var patch = new MediaAssetPatch
    {
      Label = "Quack",
      SourceType = MediaSourceType.Remote,
      Src = "https://example.com/x.mp3",
      Kind = MediaKind.Audio,
    };

    var result = MediaAssetValidation.Normalize(patch, null, catalog);

    Assert.True(result.IsSuccess);
    Assert.Equal(MediaSourceType.Remote, result.Value.SourceType);
    Assert.Equal(MediaKind.Audio, result.Value.Kind);
  }

  // ---------------------------------------------------------------------------------------
  // Local validation
  // ---------------------------------------------------------------------------------------

  [Fact]
  public void LocalMissingFileFails()
  {
    var catalog = new FakeMediaFileCatalog();
    var patch = new MediaAssetPatch
    {
      Label = "Quack",
      SourceType = MediaSourceType.Local,
      Src = "/sounds/missing.mp3",
      Kind = MediaKind.Audio,
    };

    var result = MediaAssetValidation.Normalize(patch, null, catalog);

    Assert.True(result.IsFailed);
    Assert.Contains(
      result.Errors,
      e => e.Message == "Unknown media file: /sounds/missing.mp3. Add it under public/clips or public/sounds.");
  }

  [Fact]
  public void LocalKindMismatchFails()
  {
    var catalog = new FakeMediaFileCatalog();
    catalog.AddFile("/clips/win.mp4", MediaKind.Video);
    var patch = new MediaAssetPatch
    {
      Label = "Win",
      SourceType = MediaSourceType.Local,
      Src = "/clips/win.mp4",
      Kind = MediaKind.Audio, // declared wrong on purpose
    };

    var result = MediaAssetValidation.Normalize(patch, null, catalog);

    Assert.True(result.IsFailed);
    Assert.Contains(result.Errors, e => e.Message == "/clips/win.mp4 is video, not audio.");
  }

  [Fact]
  public void LocalMatchingKindSucceedsAndOverridesDeclaredKindFromTheCatalog()
  {
    var catalog = new FakeMediaFileCatalog();
    catalog.AddFile("/sounds/quack.mp3", MediaKind.Audio);
    var patch = new MediaAssetPatch
    {
      Label = "Quack",
      SourceType = MediaSourceType.Local,
      Src = "/sounds/quack.mp3",
      Kind = MediaKind.Audio,
    };

    var result = MediaAssetValidation.Normalize(patch, null, catalog);

    Assert.True(result.IsSuccess);
    Assert.Equal(MediaKind.Audio, result.Value.Kind);
  }

  [Fact]
  public void LocalSelfRepairAllowsResavingTheSameMissingSrcWithTheSameKind()
  {
    var catalog = new FakeMediaFileCatalog(); // the file is gone from the catalog
    var current = BuildAsset(kind: MediaKind.Audio, sourceType: MediaSourceType.Local, src: "/sounds/gone.mp3");
    var patch = new MediaAssetPatch { Label = "Renamed label" }; // src/kind absent -> fall back to current

    var result = MediaAssetValidation.Normalize(patch, current, catalog);

    Assert.True(result.IsSuccess);
    Assert.Equal("/sounds/gone.mp3", result.Value.Src);
    Assert.Equal(MediaKind.Audio, result.Value.Kind);
    Assert.Equal("Renamed label", result.Value.Label);
  }

  [Fact]
  public void LocalSelfRepairBlockedWhenDeclaredKindDiffersFromCurrent()
  {
    var catalog = new FakeMediaFileCatalog(); // the file is gone from the catalog
    var current = BuildAsset(kind: MediaKind.Audio, sourceType: MediaSourceType.Local, src: "/sounds/gone.mp3");
    var patch = new MediaAssetPatch { Src = "/sounds/gone.mp3", Kind = MediaKind.Video };

    var result = MediaAssetValidation.Normalize(patch, current, catalog);

    Assert.True(result.IsFailed);
    Assert.Contains(
      result.Errors,
      e => e.Message == "/sounds/gone.mp3 is missing, so its kind cannot be changed to video.");
  }

  [Fact]
  public void LocalMissingFileWithADifferentCurrentSrcStillFails()
  {
    var catalog = new FakeMediaFileCatalog();
    var current = BuildAsset(kind: MediaKind.Audio, sourceType: MediaSourceType.Local, src: "/sounds/other.mp3");
    var patch = new MediaAssetPatch { Src = "/sounds/gone.mp3", Kind = MediaKind.Audio };

    var result = MediaAssetValidation.Normalize(patch, current, catalog);

    Assert.True(result.IsFailed);
    Assert.Contains(
      result.Errors,
      e => e.Message == "Unknown media file: /sounds/gone.mp3. Add it under public/clips or public/sounds.");
  }

  // ---------------------------------------------------------------------------------------
  // Volume / Enabled defaults and clamping
  // ---------------------------------------------------------------------------------------

  [Fact]
  public void MissingVolumeOnCreateDefaultsToPointEight()
  {
    var catalog = new FakeMediaFileCatalog();
    var patch = new MediaAssetPatch
    {
      Label = "Quack",
      SourceType = MediaSourceType.Remote,
      Src = "https://example.com/x.mp3",
      Kind = MediaKind.Audio,
    };

    var result = MediaAssetValidation.Normalize(patch, null, catalog);

    Assert.True(result.IsSuccess);
    Assert.Equal(0.8, result.Value.Volume);
  }

  [Theory]
  [InlineData(-1.0, 0.0)]
  [InlineData(1.5, 1.0)]
  [InlineData(double.NaN, 0.8)]
  public void OutOfRangeVolumeClamps(double input, double expected)
  {
    var catalog = new FakeMediaFileCatalog();
    var patch = new MediaAssetPatch
    {
      Label = "Quack",
      SourceType = MediaSourceType.Remote,
      Src = "https://example.com/x.mp3",
      Kind = MediaKind.Audio,
      Volume = input,
    };

    var result = MediaAssetValidation.Normalize(patch, null, catalog);

    Assert.True(result.IsSuccess);
    Assert.Equal(expected, result.Value.Volume);
  }

  [Fact]
  public void MissingVolumeOnUpdateFallsBackToCurrentWithoutReclamping()
  {
    var catalog = new FakeMediaFileCatalog();
    var current = BuildAsset(sourceType: MediaSourceType.Remote, src: "https://example.com/x.mp3", volume: 0.42);
    var patch = new MediaAssetPatch { Label = "Renamed" };

    var result = MediaAssetValidation.Normalize(patch, current, catalog);

    Assert.True(result.IsSuccess);
    Assert.Equal(0.42, result.Value.Volume);
  }

  [Fact]
  public void MissingEnabledOnCreateDefaultsToTrue()
  {
    var catalog = new FakeMediaFileCatalog();
    var patch = new MediaAssetPatch
    {
      Label = "Quack",
      SourceType = MediaSourceType.Remote,
      Src = "https://example.com/x.mp3",
      Kind = MediaKind.Audio,
    };

    var result = MediaAssetValidation.Normalize(patch, null, catalog);

    Assert.True(result.IsSuccess);
    Assert.True(result.Value.Enabled);
  }

  [Fact]
  public void MissingEnabledOnUpdateFallsBackToCurrent()
  {
    var catalog = new FakeMediaFileCatalog();
    var current = BuildAsset(sourceType: MediaSourceType.Remote, src: "https://example.com/x.mp3", enabled: false);
    var patch = new MediaAssetPatch { Label = "Renamed" };

    var result = MediaAssetValidation.Normalize(patch, current, catalog);

    Assert.True(result.IsSuccess);
    Assert.False(result.Value.Enabled);
  }

  [Fact]
  public void ExplicitFalseEnabledIsHonored()
  {
    var catalog = new FakeMediaFileCatalog();
    var current = BuildAsset(sourceType: MediaSourceType.Remote, src: "https://example.com/x.mp3", enabled: true);
    var patch = new MediaAssetPatch { Enabled = false };

    var result = MediaAssetValidation.Normalize(patch, current, catalog);

    Assert.True(result.IsSuccess);
    Assert.False(result.Value.Enabled);
  }

  // ---------------------------------------------------------------------------------------
  // Source type / kind required
  // ---------------------------------------------------------------------------------------

  [Fact]
  public void MissingSourceTypeOnCreateFails()
  {
    var catalog = new FakeMediaFileCatalog();
    var patch = new MediaAssetPatch { Label = "Quack", Src = "https://example.com/x.mp3", Kind = MediaKind.Audio };

    var result = MediaAssetValidation.Normalize(patch, null, catalog);

    Assert.True(result.IsFailed);
    Assert.Contains(result.Errors, e => e.Message == "Source type must be \"local\" or \"remote\".");
  }

  [Fact]
  public void MissingSrcOnCreateFails()
  {
    var catalog = new FakeMediaFileCatalog();
    var patch = new MediaAssetPatch { Label = "Quack", SourceType = MediaSourceType.Remote, Kind = MediaKind.Audio };

    var result = MediaAssetValidation.Normalize(patch, null, catalog);

    Assert.True(result.IsFailed);
    Assert.Contains(result.Errors, e => e.Message == "A media file or URL is required.");
  }

  [Fact]
  public void PartialUpdateWithOnlyLabelKeepsEveryOtherCurrentField()
  {
    var catalog = new FakeMediaFileCatalog();
    catalog.AddFile("/sounds/quack.mp3", MediaKind.Audio);
    var current = BuildAsset(
      label: "Old label", kind: MediaKind.Audio, sourceType: MediaSourceType.Local, src: "/sounds/quack.mp3",
      volume: 0.3, enabled: false);
    var patch = new MediaAssetPatch { Label = "New label" };

    var result = MediaAssetValidation.Normalize(patch, current, catalog);

    Assert.True(result.IsSuccess);
    Assert.Equal("New label", result.Value.Label);
    Assert.Equal(MediaSourceType.Local, result.Value.SourceType);
    Assert.Equal("/sounds/quack.mp3", result.Value.Src);
    Assert.Equal(MediaKind.Audio, result.Value.Kind);
    Assert.Equal(0.3, result.Value.Volume);
    Assert.False(result.Value.Enabled);
  }
}
