namespace Narya.Core.Media;

/// <summary>
/// Whether a media asset plays through a browser <c>&lt;video&gt;</c> or <c>&lt;audio&gt;</c>
/// element on the overlay — a port of legacy's <c>MediaKind</c> (<c>legacy/src/shared/api.ts</c>).
/// Serialized as lowercase JSON strings ("audio"/"video") via the global
/// <c>JsonStringEnumConverter(JsonNamingPolicy.CamelCase)</c> registered in
/// <c>Narya.Api.Program</c>. For a <see cref="MediaSourceType.Local"/> asset this is never
/// trusted from the request body — <see cref="IMediaFileCatalog.KindForLocalSrc"/> is
/// authoritative, so the overlay never picks the wrong element for a file's real content.
/// </summary>
public enum MediaKind
{
  Audio = 0,
  Video = 1,
}
