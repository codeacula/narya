using FluentResults;

namespace Narya.Core.Media;

/// <summary>
/// Resolves a <see cref="MediaAssetPatch"/> (POST body, or a partial PUT body) into a fully
/// valid <see cref="MediaAssetInput"/> — a port of legacy's <c>normalize</c>
/// (<c>legacy/src/server/mediaAssets.ts:122-153</c>), including <c>validateLocal</c>/
/// <c>validateRemote</c>. <paramref name="current"/> is <see langword="null"/> on create; the
/// existing asset (already loaded by the caller) on update.
///
/// Deliberately a plain static method rather than a MediatR/FluentValidation pipeline: unlike
/// <c>Narya.Application.Viewers.UpdateViewerProfileCommandValidator</c>'s declarative bounds
/// checks, this validation is genuinely procedural — the accepted <see cref="MediaKind"/> for a
/// local src comes from <see cref="IMediaFileCatalog.KindForLocalSrc"/> (not the request body),
/// and whether a missing local file is rejected or self-repaired depends on comparing the
/// request against <paramref name="current"/>. <c>Narya.Database.Media.MediaAssetStore</c> is the
/// only caller (see its doc comment) — this lives in Narya.Core rather than Narya.Database so it
/// stays testable without a document store.
/// </summary>
public static class MediaAssetValidation
{
  /// <summary>
  /// Legacy has no explicit label cap (just a trim + non-empty check); this adds one for
  /// safety, matching the bound <c>Narya.Application.Viewers.UpdateViewerProfileCommandValidator</c>
  /// already applies to a comparable free-text field (viewer real name).
  /// </summary>
  public const int MaxLabelLength = 120;

  private const double DefaultVolume = 0.8;

  public static Result<MediaAssetInput> Normalize(MediaAssetPatch patch, MediaAsset? current, IMediaFileCatalog catalog)
  {
    var rawLabel = patch.Label ?? current?.Label ?? string.Empty;
    var label = rawLabel.Trim();
    if (label.Length == 0)
    {
      return Result.Fail<MediaAssetInput>("A label is required.");
    }

    if (label.Length > MaxLabelLength)
    {
      return Result.Fail<MediaAssetInput>($"A label must be {MaxLabelLength} characters or fewer.");
    }

    var sourceType = patch.SourceType ?? current?.SourceType;
    if (sourceType is not (MediaSourceType.Local or MediaSourceType.Remote))
    {
      return Result.Fail<MediaAssetInput>("Source type must be \"local\" or \"remote\".");
    }

    var rawSrc = patch.Src ?? current?.Src ?? string.Empty;
    var src = rawSrc.Trim();
    if (src.Length == 0)
    {
      return Result.Fail<MediaAssetInput>("A media file or URL is required.");
    }

    var declaredKind = patch.Kind ?? current?.Kind;
    if (declaredKind is not (MediaKind.Audio or MediaKind.Video))
    {
      return Result.Fail<MediaAssetInput>("Media kind must be \"video\" or \"audio\".");
    }

    // Local kind comes from the file on disk, not the client.
    Result<MediaKind> kindResult = sourceType == MediaSourceType.Local
      ? ValidateLocal(src, declaredKind.Value, current, catalog)
      : Result.Ok(declaredKind.Value);
    if (kindResult.IsFailed)
    {
      return Result.Fail<MediaAssetInput>(kindResult.Errors);
    }

    if (sourceType == MediaSourceType.Remote)
    {
      var remoteResult = ValidateRemote(src);
      if (remoteResult.IsFailed)
      {
        return Result.Fail<MediaAssetInput>(remoteResult.Errors);
      }
    }

    // legacy: `value.volume === undefined && current ? current.volume : clampVolume(value.volume)`
    var volume = patch.Volume is null && current is not null ? current.Volume : ClampVolume(patch.Volume);

    // legacy: `value.enabled === undefined ? (current ? current.enabled !== 0 : true) : Boolean(value.enabled)`
    var enabled = patch.Enabled ?? current?.Enabled ?? true;

    return Result.Ok(new MediaAssetInput(label, kindResult.Value, sourceType.Value, src, volume, enabled));
  }

  /// <summary>
  /// A local src must resolve through <see cref="IMediaFileCatalog"/> — the security boundary.
  /// Bindings are checked against the files actually served rather than pattern-matched, so
  /// traversal and off-site srcs fail by simply not being found.
  ///
  /// <paramref name="current"/> is the asset being updated. If its file has since disappeared
  /// from the catalog, re-saving that SAME src is still allowed (self-repair): otherwise a
  /// broken entry could never be renamed, disabled, or repaired once its file went missing.
  /// </summary>
  /// <summary>
  /// A three-way branch (file found / missing-but-self-repairable / missing): a switch
  /// expression reads that mapping directly, rather than nested if/early-returns.
  /// </summary>
  private static Result<MediaKind> ValidateLocal(string src, MediaKind declaredKind, MediaAsset? current, IMediaFileCatalog catalog)
  {
    var fileKind = catalog.KindForLocalSrc(src);
    var isSelfRepair = current is { SourceType: MediaSourceType.Local } && current.Src == src;

    return (fileKind, isSelfRepair) switch
    {
      // The overlay picks <video> vs <audio> from the stored kind, so a mismatch would play an
      // mp3 in a video element.
      ({ } kind, _) when declaredKind == kind => Result.Ok(kind),
      ({ } kind, _) => Result.Fail<MediaKind>($"{src} is {Label(kind)}, not {Label(declaredKind)}."),
      (null, true) when declaredKind == current!.Kind => Result.Ok(current.Kind),
      (null, true) => Result.Fail<MediaKind>(
        $"{src} is missing, so its kind cannot be changed to {Label(declaredKind)}."),
      (null, false) => Result.Fail<MediaKind>($"Unknown media file: {src}. Add it under public/clips or public/sounds."),
    };
  }

  /// <summary>Remote srcs are never resolved against the filesystem, so only http(s) is accepted.</summary>
  private static Result ValidateRemote(string src)
  {
    var isAbsoluteUrl = Uri.TryCreate(src, UriKind.Absolute, out var uri);
    var isHttpOrHttps = isAbsoluteUrl && (uri!.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps);

    return (isAbsoluteUrl, isHttpOrHttps) switch
    {
      (false, _) => Result.Fail($"{src} is not a valid URL."),
      (true, false) => Result.Fail("A remote source must be an http:// or https:// URL."),
      (true, true) => Result.Ok(),
    };
  }

  private static double ClampVolume(double? value)
  {
    var volume = value is { } v && double.IsFinite(v) ? v : DefaultVolume;
    return Math.Clamp(volume, 0, 1);
  }

  private static string Label(MediaKind kind) => kind == MediaKind.Audio ? "audio" : "video";
}
