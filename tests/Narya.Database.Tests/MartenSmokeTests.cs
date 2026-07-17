using Narya.Database.Tests.Fixtures;

namespace Narya.Database.Tests;

[Collection("postgres")]
public sealed class MartenSmokeTests(PostgresFixture fixture)
{
  /// <summary>
  /// Marten generates document-storage code at runtime and requires the document
  /// type to be public (a private nested record fails with CS0122 at storage
  /// codegen time), so this deviates from the brief's <c>private sealed record</c>.
  /// </summary>
  public sealed record Doc(Guid Id, string Name);

  [Fact]
  public async Task StoresAndLoadsADocument()
  {
    await using var store = fixture.CreateStore();
    await using var session = store.LightweightSession();
    var doc = new Doc(Guid.NewGuid(), "hello");
    session.Store(doc);
    await session.SaveChangesAsync();

    await using var query = store.QuerySession();
    var loaded = await query.LoadAsync<Doc>(doc.Id);
    Assert.Equal("hello", loaded!.Name);
  }
}
