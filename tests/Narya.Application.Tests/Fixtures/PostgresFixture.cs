using Marten;

using Testcontainers.PostgreSql;

namespace Narya.Application.Tests.Fixtures;

/// <summary>
/// Mirrors <c>Narya.Database.Tests.Fixtures.PostgresFixture</c> (and its copies in
/// <c>Narya.Twitch.Tests</c>) — kept as a separate copy rather than a cross-test-project
/// reference (no other test project in the solution references another test project), so this
/// project's xunit test discovery only ever sees its own tests. Used exclusively by
/// <c>Narya.Application.Tests.Automation.RedeemOnceTests</c>, which needs a REAL Postgres so the
/// <c>AutomationRunDocument.DedupeKey</c> partial unique index (the dedup mechanism under test)
/// is proven at the database level rather than simulated.
/// </summary>
public sealed class PostgresFixture : IAsyncLifetime
{
  private readonly PostgreSqlContainer _container = new PostgreSqlBuilder("postgres:17-alpine")
    .Build();

  public string ConnectionString => _container.GetConnectionString();

  public DocumentStore CreateStore(Action<StoreOptions>? configure = null) =>
    DocumentStore.For(options =>
    {
      options.Connection(ConnectionString);
      configure?.Invoke(options);
    });

  public Task InitializeAsync() => _container.StartAsync();
  public Task DisposeAsync() => _container.DisposeAsync().AsTask();
}

[CollectionDefinition("postgres")]
public sealed class PostgresCollection : ICollectionFixture<PostgresFixture>;
