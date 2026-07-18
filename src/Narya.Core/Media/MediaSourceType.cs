namespace Narya.Core.Media;

/// <summary>
/// Where a configured asset's bytes come from — a port of legacy's <c>MediaSourceType</c>
/// (<c>legacy/src/shared/api.ts</c>). <see cref="Local"/> srcs must resolve to a file the
/// server actually serves (<see cref="IMediaFileCatalog"/> is the authoritative check —
/// never a regex/pattern match, so a crafted path cannot escape the served roots or claim a
/// file that doesn't exist). <see cref="Remote"/> is an explicitly configured http(s) URL.
/// </summary>
public enum MediaSourceType
{
  Local = 0,
  Remote = 1,
}
