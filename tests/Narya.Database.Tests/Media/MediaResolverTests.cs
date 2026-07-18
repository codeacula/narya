using Marten;

using Narya.Core.Media;
using Narya.Database.Media;
using Narya.Database.Tests.Fixtures;

namespace Narya.Database.Tests.Media;

/// <summary>
/// <see cref="MediaResolver.ResolveForPlaybackAsync"/> — THE playback choke point (see
/// <see cref="IMediaResolver"/>'s doc comment). Backed by a real <see cref="MediaAssetStore"/>
/// against Testcontainers Postgres so the enabled/available gate is exercised end to end, not
/// just against a store double.
/// </summary>
[Collection("postgres")]
public sealed class MediaResolverTests(PostgresFixture fixture)
{
  private sealed class FakeMediaFileCatalog : IMediaFileCatalog
  {
    private readonly Dictionary<string, MediaKind> _files = new(StringComparer.Ordinal);
    private readonly HashSet<string> _unavailable = new(StringComparer.Ordinal);

    public void AddFile(string src, MediaKind kind) => _files[src] = kind;

    public void MarkUnavailable(string src) => _unavailable.Add(src);

    public bool IsAvailable(MediaSourceType sourceType, string src) =>
      sourceType == MediaSourceType.Remote || (_files.ContainsKey(src) && !_unavailable.Contains(src));

    public MediaKind? KindForLocalSrc(string src) => _files.TryGetValue(src, out var kind) ? kind : null;

    public IReadOnlyList<MediaFile> Discovered() => [];
  }

  private async Task<IDocumentStore> BuildCleanDocumentStoreAsync()
  {
    var documentStore = fixture.CreateStore(NaryaMartenConfig.Configure);
    await documentStore.Storage.ApplyAllConfiguredChangesToDatabaseAsync();
    await documentStore.Advanced.Clean.DeleteAllEventDataAsync(CancellationToken.None);
    await documentStore.Advanced.Clean.DeleteAllDocumentsAsync(CancellationToken.None);
    return documentStore;
  }

  [Fact]
  public async Task UnknownIdResolvesToNull()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var assetStore = new MediaAssetStore(documentStore, new FakeMediaFileCatalog(), TimeProvider.System);
    var resolver = new MediaResolver(assetStore);

    var resolved = await resolver.ResolveForPlaybackAsync(Guid.NewGuid(), CancellationToken.None);

    Assert.Null(resolved);
  }

  [Fact]
  public async Task DisabledAssetResolvesToNullEvenWhenAvailable()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var assetStore = new MediaAssetStore(documentStore, new FakeMediaFileCatalog(), TimeProvider.System);
    var resolver = new MediaResolver(assetStore);
    var created = await assetStore.CreateAsync(
      new MediaAssetPatch
      {
        Label = "Air Horn",
        Kind = MediaKind.Audio,
        SourceType = MediaSourceType.Remote,
        Src = "https://example.com/air-horn.mp3",
        Enabled = false,
      },
      CancellationToken.None);

    var resolved = await resolver.ResolveForPlaybackAsync(created.Value.Id, CancellationToken.None);

    Assert.Null(resolved);
  }

  [Fact]
  public async Task LocalAssetWhoseFileWentMissingResolvesToNull()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var catalog = new FakeMediaFileCatalog();
    catalog.AddFile("/sounds/quack.mp3", MediaKind.Audio);
    var assetStore = new MediaAssetStore(documentStore, catalog, TimeProvider.System);
    var resolver = new MediaResolver(assetStore);
    var created = await assetStore.CreateAsync(
      new MediaAssetPatch { Label = "Quack", Kind = MediaKind.Audio, SourceType = MediaSourceType.Local, Src = "/sounds/quack.mp3" },
      CancellationToken.None);

    catalog.MarkUnavailable("/sounds/quack.mp3");
    var resolved = await resolver.ResolveForPlaybackAsync(created.Value.Id, CancellationToken.None);

    Assert.Null(resolved);
  }

  [Fact]
  public async Task RemoteEnabledAssetResolvesToTheAssetWithAvailableTrue()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var assetStore = new MediaAssetStore(documentStore, new FakeMediaFileCatalog(), TimeProvider.System);
    var resolver = new MediaResolver(assetStore);
    var created = await assetStore.CreateAsync(
      new MediaAssetPatch
      {
        Label = "Air Horn",
        Kind = MediaKind.Audio,
        SourceType = MediaSourceType.Remote,
        Src = "https://example.com/air-horn.mp3",
      },
      CancellationToken.None);

    var resolved = await resolver.ResolveForPlaybackAsync(created.Value.Id, CancellationToken.None);

    Assert.NotNull(resolved);
    Assert.Equal(created.Value.Id, resolved.Id);
    Assert.True(resolved.Available);
  }

  [Fact]
  public async Task LocalAvailableEnabledAssetResolvesToTheAsset()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var catalog = new FakeMediaFileCatalog();
    catalog.AddFile("/clips/win.mp4", MediaKind.Video);
    var assetStore = new MediaAssetStore(documentStore, catalog, TimeProvider.System);
    var resolver = new MediaResolver(assetStore);
    var created = await assetStore.CreateAsync(
      new MediaAssetPatch { Label = "Win", Kind = MediaKind.Video, SourceType = MediaSourceType.Local, Src = "/clips/win.mp4" },
      CancellationToken.None);

    var resolved = await resolver.ResolveForPlaybackAsync(created.Value.Id, CancellationToken.None);

    Assert.NotNull(resolved);
    Assert.Equal(created.Value.Id, resolved.Id);
    Assert.True(resolved.Available);
  }
}
